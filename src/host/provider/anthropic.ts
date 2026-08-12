import { Buffer } from 'node:buffer';
import type { Secret } from '../secret.ts';
import {
  AnthropicApiError,
  AnthropicNetworkError,
  createFetchTransport,
  isAbortError,
  type AnthropicTransport,
  type MessagesRequest,
  type RawUsage,
  type SystemBlock,
} from './transport.ts';
import type {
  Effort,
  Provider,
  ProviderErrorKind,
  SolveEvent,
  SolveImage,
  SolveOptions,
  Usage,
} from './types.ts';

/**
 * The Anthropic implementation of the provider seam.
 *
 * It wraps the model call and nothing else — no capture, no window resolution,
 * no budget accounting, no HTTP server. Everything it needs arrives through
 * {@link ProviderConfig}, which is what lets the whole module be exercised
 * against a fake transport.
 */

/** Conservative by design: effort moves cost more than image size does. */
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_EFFORT: Effort = 'medium';

/**
 * In practice a thinking budget — measured visible answers run 255–305 tokens.
 * Lowering it trades a bounded saving for a truncated code block that looks
 * runnable, so instead the ceiling stays and `done.stopReason` makes a
 * `max_tokens` stop detectable.
 */
export const DEFAULT_MAX_TOKENS = 8000;

/**
 * The measured prompt (1196–1496 tokens) clears the model's minimum cacheable
 * prefix, and kata pacing is bursty with gaps — an hour is the useful TTL.
 * Not a config flag: it is request mechanics, sealed inside the seam.
 */
export const SYSTEM_PROMPT_CACHE_TTL = '1h';

/** Three attempts total. Waits are short — a human is watching a button. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 2000];

export interface ProviderConfig {
  /** Host-process only; revealed once per request, inside the transport. */
  readonly apiKey: Secret;
  /**
   * Fixed at construction, never per call — that is what makes the cached
   * prefix stable across solves. Carried into the request unmodified; this
   * module does not author, trim, or template it.
   */
  readonly systemPrompt: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly maxTokens?: number;
  /** Injected by tests. Production leaves it unset and gets the real wire. */
  readonly transport?: AnthropicTransport;
  readonly baseUrl?: string;
  /** One entry per retry; `[]` disables retrying entirely. */
  readonly retryDelaysMs?: readonly number[];
}

export function createProvider(config: ProviderConfig): Provider {
  const model = config.model ?? DEFAULT_MODEL;
  const effort = config.effort ?? DEFAULT_EFFORT;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const retryDelaysMs = config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const transport =
    config.transport ?? createFetchTransport({ apiKey: config.apiKey, baseUrl: config.baseUrl });

  // Built once, shared by every request: prompt caching is a prefix match, so a
  // freshly-rendered system block per call would still hit, but a frozen one
  // makes it impossible to accidentally interpolate something volatile.
  const systemBlock: SystemBlock = {
    type: 'text',
    text: config.systemPrompt,
    cache_control: { type: 'ephemeral', ttl: SYSTEM_PROMPT_CACHE_TTL },
  };
  const system: readonly SystemBlock[] = Object.freeze([systemBlock]);

  function buildRequest(image: SolveImage, transcript: string | undefined): MessagesRequest {
    return {
      model,
      max_tokens: maxTokens,
      stream: true,
      system,
      // The image differs every call and so sits after the cached prefix,
      // which is where the render order (tools → system → messages) puts it.
      //
      // The transcript, when there is one, follows the image rather than
      // preceding it: images before text matches Anthropic's own guidance, and
      // it keeps the screenshot — which the system prompt names as
      // authoritative — as the first thing the model reads. Both blocks sit
      // after the cached system prefix, so adding one costs nothing in cache
      // hits; a request with no transcript is byte-identical to what this
      // built before the option existed.
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: Buffer.from(image.bytes).toString('base64'),
              },
            },
            ...(transcript === undefined || transcript === ''
              ? []
              : [{ type: 'text' as const, text: wrapTranscript(transcript) }]),
          ],
        },
      ],
      output_config: { effort },
    };
  }

  async function* solve(image: SolveImage, options: SolveOptions = {}): AsyncGenerator<SolveEvent> {
    const signal = options.signal;
    // A call, not a comparison: the abort can land between any two statements,
    // so the check must be re-evaluated rather than narrowed away.
    const aborted = (): boolean => signal?.aborted === true;
    const body = buildRequest(image, options.transcript);

    for (let attempt = 0; ; attempt += 1) {
      if (aborted()) return;

      const usage: MutableUsage = { ...ZERO_USAGE };
      let stopReason: string | null = null;
      let sawTerminalEvent = false;
      let emittedText = false;
      let failure: Failure | undefined;

      try {
        for await (const event of transport({ body, signal })) {
          if (aborted()) return;

          switch (event.type) {
            case 'message_start':
              applyUsage(usage, event.message?.usage);
              break;

            case 'content_block_delta': {
              // Only answer text. `thinking_delta` blocks ride the same event
              // and must never reach the answer pane.
              if (event.delta?.type !== 'text_delta') break;
              const text = event.delta.text;
              if (text === undefined || text === '') break;
              emittedText = true;
              yield { type: 'delta', text };
              break;
            }

            case 'message_delta':
              applyUsage(usage, event.usage);
              if (event.delta?.stop_reason !== undefined) {
                stopReason = event.delta.stop_reason;
                sawTerminalEvent = true;
              }
              break;

            case 'message_stop':
              sawTerminalEvent = true;
              break;

            case 'error':
              failure = classifyStreamError(event.error);
              break;

            default:
              break;
          }

          if (failure !== undefined) break;
        }
      } catch (error) {
        if (isAbortError(error) || aborted()) return;
        failure = classifyThrown(error);
      }

      if (failure === undefined && !sawTerminalEvent) {
        // The body ended without the stream ever saying it was finished — a
        // severed connection looks exactly like this.
        failure = {
          kind: 'transient',
          message: 'The provider stream ended before the answer was complete.',
          retryable: true,
        };
      }

      if (failure === undefined) {
        if (stopReason === 'refusal') {
          yield { type: 'error', kind: 'refusal', message: 'The provider declined this request.' };
          return;
        }
        yield { type: 'done', usage: { ...usage }, stopReason };
        return;
      }

      // Retrying after text has streamed would duplicate it in the pane, so a
      // stream that dies mid-answer surfaces instead — the caller keeps the
      // partial and appends an error marker.
      const canRetry = failure.retryable && !emittedText && attempt < retryDelaysMs.length;
      if (!canRetry) {
        yield { type: 'error', kind: failure.kind, message: failure.message };
        return;
      }

      const slept = await sleep(retryDelaysMs[attempt] ?? 0, signal);
      if (!slept) return;
    }
  }

  return Object.freeze({ model, solve });
}

/**
 * The tag pair the system prompt tells the model to expect. Fixed here rather
 * than in `system-prompt.ts` because it is request mechanics — the two have to
 * agree, and this is the side that actually emits it.
 */
function wrapTranscript(transcript: string): string {
  return `<recent_transcript>\n${transcript}\n</recent_transcript>`;
}

interface MutableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

const ZERO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

/** Later events restate totals rather than adding to them — last write wins. */
function applyUsage(into: MutableUsage, raw: RawUsage | undefined): void {
  if (raw === undefined) return;
  if (typeof raw.input_tokens === 'number') into.inputTokens = raw.input_tokens;
  if (typeof raw.output_tokens === 'number') into.outputTokens = raw.output_tokens;
  if (typeof raw.cache_creation_input_tokens === 'number') {
    into.cacheCreationInputTokens = raw.cache_creation_input_tokens;
  }
  if (typeof raw.cache_read_input_tokens === 'number') {
    into.cacheReadInputTokens = raw.cache_read_input_tokens;
  }
}

interface Failure {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly retryable: boolean;
}

const AUTH_ERROR_TYPES = new Set(['authentication_error', 'permission_error']);
const RETRYABLE_ERROR_TYPES = new Set([
  'api_error',
  'overloaded_error',
  'rate_limit_error',
  'timeout_error',
]);
/** Statuses below 500 that are still worth another attempt. */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

function classifyThrown(error: unknown): Failure {
  if (error instanceof AnthropicApiError) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      (error.errorType !== undefined && AUTH_ERROR_TYPES.has(error.errorType))
    ) {
      return { kind: 'auth', message: error.message, retryable: false };
    }
    return {
      kind: 'transient',
      message: error.message,
      // A 400 or a 404 is a bug in this app, not a flaky moment; retrying it
      // just spends two more calls to reach the same answer. It still surfaces
      // as `transient` because that is the only kind the taxonomy has for it.
      retryable: error.status >= 500 || RETRYABLE_STATUSES.has(error.status),
    };
  }

  if (error instanceof AnthropicNetworkError) {
    return { kind: 'transient', message: error.message, retryable: true };
  }

  return { kind: 'transient', message: describe(error), retryable: false };
}

function classifyStreamError(raw: { type?: string; message?: string } | undefined): Failure {
  const type = raw?.type;
  const message = raw?.message ?? 'The provider stream reported an error.';

  if (type !== undefined && AUTH_ERROR_TYPES.has(type)) {
    return { kind: 'auth', message, retryable: false };
  }
  return {
    kind: 'transient',
    message,
    retryable: type !== undefined && RETRYABLE_ERROR_TYPES.has(type),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves `true` after the wait, `false` if the caller aborted during it. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }

    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);

    onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
