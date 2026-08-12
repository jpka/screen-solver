import type { Secret } from '../secret.ts';
import type { Effort } from './types.ts';

/**
 * The wire. Everything below this line is HTTP and SSE mechanics; nothing here
 * knows what a "solve" is.
 *
 * Splitting it out is what makes the seam testable: `createProvider` takes an
 * {@link AnthropicTransport}, so a test drives canned streams and canned
 * failures through the exact same code path the real call takes, with no
 * network and no SDK.
 */

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const MESSAGES_PATH = '/v1/messages';

export interface CacheControl {
  readonly type: 'ephemeral';
  readonly ttl?: '5m' | '1h';
}

export interface SystemBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: CacheControl;
}

export interface ImageContentBlock {
  readonly type: 'image';
  readonly source: {
    readonly type: 'base64';
    readonly media_type: string;
    readonly data: string;
  };
}

export interface TextContentBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface UserMessage {
  readonly role: 'user';
  /**
   * The image is always present; a text block follows it only when the caller
   * supplied a transcript. Order is load-bearing — see `buildRequest` in
   * `anthropic.ts`.
   */
  readonly content: readonly (ImageContentBlock | TextContentBlock)[];
}

/** The request body, in wire shape — snake_case on purpose, it is JSON. */
export interface MessagesRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly stream: true;
  readonly system: readonly SystemBlock[];
  readonly messages: readonly UserMessage[];
  /** `effort` lives inside `output_config`, not at the top level. */
  readonly output_config: { readonly effort: Effort };
}

export interface RawUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

/**
 * A server-sent event off the messages stream, typed loosely on purpose.
 *
 * The stream carries more event types than this module cares about, and new
 * ones appear over time; modelling the union exhaustively would mean editing
 * this file every time the API grows a block type. The provider matches on
 * `type` and ignores the rest.
 */
export interface AnthropicStreamEvent {
  readonly type: string;
  readonly message?: { readonly usage?: RawUsage };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly stop_reason?: string | null;
  };
  readonly usage?: RawUsage;
  readonly error?: { readonly type?: string; readonly message?: string };
}

/** A non-2xx response. `status` and `errorType` drive the failure taxonomy. */
export class AnthropicApiError extends Error {
  readonly status: number;
  readonly errorType: string | undefined;

  constructor(status: number, message: string, errorType?: string) {
    super(message);
    this.name = 'AnthropicApiError';
    this.status = status;
    this.errorType = errorType;
  }
}

/** The request never got an answer: DNS, TCP, TLS, a severed body. Retryable. */
export class AnthropicNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AnthropicNetworkError';
  }
}

export interface TransportRequest {
  readonly body: MessagesRequest;
  readonly signal: AbortSignal | undefined;
}

/**
 * Send one streaming request.
 *
 * Throws {@link AnthropicApiError} / {@link AnthropicNetworkError} for
 * transport-level failures, and yields the raw stream otherwise. Classifying
 * those failures is the provider's job, not the transport's — that keeps a fake
 * able to reproduce any failure the real wire can produce.
 */
export type AnthropicTransport = (request: TransportRequest) => AsyncIterable<AnthropicStreamEvent>;

export interface FetchTransportOptions {
  readonly apiKey: Secret;
  readonly baseUrl?: string;
  /** Injected by the transport's own tests; production uses global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createFetchTransport(options: FetchTransportOptions): AnthropicTransport {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${baseUrl}${MESSAGES_PATH}`;

  return async function* send(request) {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': ANTHROPIC_VERSION,
          // The one place the key is ever revealed.
          'x-api-key': options.apiKey.reveal(),
        },
        body: JSON.stringify(request.body),
        signal: request.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new AnthropicNetworkError(`Could not reach ${url}.`, { cause: error });
    }

    if (!response.ok) {
      throw await readApiError(response);
    }
    if (response.body === null) {
      throw new AnthropicNetworkError('The provider returned no response body.');
    }

    yield* parseServerSentEvents(readBytes(response.body));
  };
}

/**
 * Turn a byte stream into SSE payloads.
 *
 * Exported because it is the one piece of this module with enough logic to be
 * worth testing directly — chunk boundaries land wherever the network puts
 * them, including mid-line and mid-multi-byte-character.
 */
export async function* parseServerSentEvents(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<AnthropicStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];

  const flush = (): AnthropicStreamEvent | undefined => {
    if (data.length === 0) return undefined;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') return undefined;
    try {
      return JSON.parse(payload) as AnthropicStreamEvent;
    } catch (error) {
      throw new AnthropicNetworkError('The provider sent a malformed stream event.', {
        cause: error,
      });
    }
  };

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });

    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;

      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

      if (line === '') {
        const event = flush();
        if (event !== undefined) yield event;
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        const value = line.slice('data:'.length);
        data.push(value.startsWith(' ') ? value.slice(1) : value);
      }
      // `event:` and `id:` lines carry nothing the payload doesn't already say.
    }
  }

  const trailing = flush();
  if (trailing !== undefined) yield trailing;
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
    // Also runs when the consumer walks away mid-stream (abort, or an error
    // event that ends the solve early); without it the socket leaks.
    await reader.cancel().catch(() => {});
  }
}

async function readApiError(response: Response): Promise<AnthropicApiError> {
  const raw = await response.text().catch(() => '');

  let errorType: string | undefined;
  let message = raw.trim();
  try {
    const parsed = JSON.parse(raw) as { error?: { type?: string; message?: string } };
    if (parsed.error !== undefined) {
      errorType = parsed.error.type;
      message = parsed.error.message ?? message;
    }
  } catch {
    // Not JSON — an intermediary, most likely. The status carries the meaning.
  }

  return new AnthropicApiError(
    response.status,
    message === '' ? `The provider returned HTTP ${response.status}.` : message,
    errorType,
  );
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}
