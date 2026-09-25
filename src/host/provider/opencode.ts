import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Secret } from '../secret.ts';
import { isAbortError, parseServerSentEvents } from './transport.ts';
import type { ModelChoice, Provider, ProviderErrorKind, SolveEvent, SolveImage, SolveOptions, Usage } from './types.ts';

/** OpenCode Zen exposes OpenAI's Responses API at this base URL. */
export const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_OPENCODE_MODEL = 'gpt-5.6-terra';

/** Kept deliberately small and vision-capable; the server rejects arbitrary model IDs. */
export const OPENCODE_MODELS: readonly ModelChoice[] = Object.freeze([
  { id: 'gpt-5.6-astra', name: 'GPT-5.6 Astra' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
]);

export const OPENCODE_GO_MODELS: readonly ModelChoice[] = Object.freeze([
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'grok-4.7', name: 'Grok 4.7' },
  { id: 'grok-4.6', name: 'Grok 4.6' },
  { id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor' },
  { id: 'muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor' },
]);

export interface OpenCodeProviderConfig {
  readonly apiKey: Secret;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly models?: readonly ModelChoice[];
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Go uses this stable process-session ID for routing and prompt caching. */
  readonly sessionId?: string;
}

/**
 * OpenCode Zen's Responses API adapter. It deliberately owns only the wire
 * translation; capture, selection and HTTP routes keep using `Provider`.
 */
export function createOpenCodeProvider(config: OpenCodeProviderConfig): Provider {
  const model = config.model ?? DEFAULT_OPENCODE_MODEL;
  const models = config.models ?? OPENCODE_MODELS;
  const baseUrl = (config.baseUrl ?? OPENCODE_BASE_URL).replace(/\/+$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;
  const sessionId = config.sessionId ?? randomUUID();

  async function* solve(image: SolveImage | null, options: SolveOptions = {}): AsyncGenerator<SolveEvent> {
    if (image === null && (options.transcript === undefined || options.transcript === '')) {
      yield { type: 'error', kind: 'transient', message: 'A solve needs either a screenshot or a transcript; this request had neither.' };
      return;
    }

    const signal = options.signal;
    const selectedModel = options.model ?? model;
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey.reveal()}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': 'screen-solver/1.0',
          ...(baseUrl === OPENCODE_GO_BASE_URL ? { 'x-opencode-session': sessionId } : {}),
        },
        body: JSON.stringify(buildRequest(config.systemPrompt, selectedModel, image, options.transcript)),
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) return;
      yield { type: 'error', kind: 'transient', message: `Could not reach ${baseUrl}/responses.` };
      return;
    }

    if (!response.ok) {
      yield { type: 'error', kind: response.status === 401 || response.status === 403 ? 'auth' : 'transient', message: await errorMessage(response) };
      return;
    }
    if (response.body === null) {
      yield { type: 'error', kind: 'transient', message: 'The OpenCode provider returned no response body.' };
      return;
    }

    let usage: Usage = ZERO_USAGE;
    let completed = false;
    try {
      for await (const event of parseServerSentEvents(readBytes(response.body))) {
        if (signal?.aborted) return;
        const raw = event as OpenCodeEvent;
        if (raw.type === 'response.output_text.delta' && typeof raw.delta === 'string' && raw.delta !== '') {
          yield { type: 'delta', text: raw.delta };
        } else if (raw.type === 'response.completed') {
          completed = true;
          usage = usageFrom(raw.response?.usage);
        } else if (raw.type === 'response.failed' || raw.type === 'response.incomplete' || raw.type === 'error') {
          yield { type: 'error', kind: classifyEvent(raw), message: raw.error?.message ?? 'The OpenCode provider reported an error.' };
          return;
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) return;
      yield { type: 'error', kind: 'transient', message: error instanceof Error ? error.message : String(error) };
      return;
    }

    if (!completed) {
      yield { type: 'error', kind: 'transient', message: 'The OpenCode stream ended before the answer was complete.' };
      return;
    }
    yield { type: 'done', usage, stopReason: 'completed' };
  }

  return Object.freeze({ model, models: Object.freeze([...models]), solve });
}

/** OpenCode Go's Responses-compatible subset, with its own endpoint and catalog. */
export function createOpenCodeGoProvider(config: Omit<OpenCodeProviderConfig, 'baseUrl' | 'models' | 'model'> & { readonly model?: string }): Provider {
  return createOpenCodeProvider({
    ...config,
    baseUrl: OPENCODE_GO_BASE_URL,
    model: config.model ?? 'gpt-5.6-luna',
    models: OPENCODE_GO_MODELS,
  });
}

function buildRequest(systemPrompt: string, model: string, image: SolveImage | null, transcript: string | undefined): object {
  return {
    model,
    instructions: systemPrompt,
    stream: true,
    input: [{
      role: 'user',
      content: [
        ...(image === null ? [] : [{ type: 'input_image', image_url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`, detail: 'auto' }]),
        ...(transcript === undefined || transcript === '' ? [] : [{ type: 'input_text', text: `<recent_transcript>\n${transcript}\n</recent_transcript>` }]),
      ],
    }],
  };
}

interface OpenCodeEvent {
  readonly type: string;
  readonly delta?: string;
  readonly error?: { readonly message?: string; readonly code?: string };
  readonly response?: { readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number; readonly input_tokens_details?: { readonly cached_tokens?: number } } };
}

const ZERO_USAGE: Usage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });

function usageFrom(raw: { readonly input_tokens?: number; readonly output_tokens?: number; readonly input_tokens_details?: { readonly cached_tokens?: number } } | undefined): Usage {
  const usage = raw;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
  };
}

function classifyEvent(event: OpenCodeEvent): ProviderErrorKind {
  return event.error?.code === 'invalid_api_key' ? 'auth' : 'transient';
}

async function errorMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return (parsed.error?.message ?? raw.trim()) || `The OpenCode provider returned HTTP ${response.status}.`;
  } catch {
    return raw.trim() || `The OpenCode provider returned HTTP ${response.status}.`;
  }
}

async function* readBytes(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
