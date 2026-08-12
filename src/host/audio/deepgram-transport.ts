import type { Secret } from '../secret.ts';

/**
 * The wire. Everything below this line is WebSocket and query-string
 * mechanics; nothing here knows what a transcript is.
 *
 * Split out for exactly the reason `provider/transport.ts` is: it makes the
 * seam testable. `createDeepgramTranscriber` takes an
 * {@link OpenDeepgramSocket}, so a test drives canned messages, canned close
 * codes, and canned handshake failures through the identical code path the
 * real socket takes -- with no network and no SDK.
 *
 * No SDK, per `AGENTS.md`: `package.json` has no runtime dependencies and
 * shouldn't grow one for something this small. Node 24's global `WebSocket`
 * is undici's, and undici's constructor accepts an options object with
 * `headers` -- an extension over the browser API, and the reason this can send
 * Deepgram's documented `Authorization: Token …` directly instead of falling
 * back to their `Sec-WebSocket-Protocol: token, <key>` browser workaround.
 */

export const DEEPGRAM_BASE_URL = 'wss://api.deepgram.com';
export const LISTEN_PATH = '/v1/listen';

/**
 * Deepgram's current general-purpose streaming model. Not `flux`, which is a
 * conversational turn-taking model built for voice agents -- wrong tool for
 * transcribing one side of a call.
 */
export const DEEPGRAM_MODEL = 'nova-3';

/**
 * 16 kHz mono is the floor Deepgram recommends for telephony-and-better
 * quality, and the renderer produces it directly by running its `AudioContext`
 * at this rate. Raising it would double the bytes over IPC and the socket for
 * no accuracy Deepgram actually uses.
 */
export const SAMPLE_RATE_HZ = 16_000;

/**
 * The close code Deepgram sends when the bytes we streamed could not be
 * decoded as audio under the parameters we declared (`DATA-0000`). A bug in
 * this app -- never retried.
 */
export const CLOSE_CODE_AUDIO_REJECTED = 1008;

/** Deepgram's own inactivity/timeout closes (`NET-0000` … `NET-0002`). Retryable. */
export const CLOSE_CODE_SERVER_ERROR = 1011;

/**
 * The query string, frozen at construction.
 *
 * These are request mechanics, not user-facing configuration, and they are
 * sealed inside the seam for the same reason `SYSTEM_PROMPT_CACHE_TTL` is:
 * `encoding`/`sample_rate`/`channels` in particular have to agree exactly with
 * what `static/renderer/pcm-worklet.js` produces, and a config flag that let
 * them drift apart would turn a typo into Deepgram's `1008` close.
 *
 * `endpointing=300` is the pause length that ends an utterance. Deepgram's
 * default of 10ms produces a torrent of one-or-two-word finals; 300ms yields
 * roughly sentence-shaped lines, which is what both the transcript pane and
 * the model context want.
 */
export function listenUrl(baseUrl: string = DEEPGRAM_BASE_URL): string {
  const url = new URL(LISTEN_PATH, baseUrl.replace(/\/+$/, '') + '/');
  url.search = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: 'en',
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE_HZ),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '300',
  }).toString();
  return url.toString();
}

export function authHeaders(apiKey: Secret): Record<string, string> {
  // The one place the key is ever revealed, mirroring `provider/transport.ts`.
  return { authorization: `Token ${apiKey.reveal()}` };
}

/**
 * One message off the live stream, typed loosely on purpose.
 *
 * Same reasoning as `AnthropicStreamEvent`: the stream also carries
 * `Metadata`, `UtteranceEnd`, and `SpeechStarted` frames this app has no use
 * for, and Deepgram adds more over time. Modelling the union exhaustively
 * would mean editing this file every time the API grows a frame type.
 */
export interface DeepgramMessage {
  readonly type?: string;
  readonly is_final?: boolean;
  readonly speech_final?: boolean;
  readonly start?: number;
  readonly duration?: number;
  readonly channel?: {
    readonly alternatives?: readonly { readonly transcript?: string }[];
  };
}

/**
 * The narrow socket surface the domain layer is allowed to see.
 *
 * Callback registration rather than `EventTarget`, so a fake is a plain
 * object -- no `addEventListener` semantics, no `Event` wrappers, no DOM
 * types leaking into `src/host`.
 */
export interface DeepgramSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (raw: string) => void): void;
  /**
   * `code`/`reason` are Deepgram's when the connection got far enough to have
   * them. A failed *handshake* also lands here, but with nothing useful:
   * Deepgram reports the reason in a `dg-error` response header, and a
   * browser-style WebSocket only exposes response headers on a *successful*
   * upgrade. That blind spot is why `deepgram.ts` runs an HTTP pre-flight
   * rather than trying to tell a bad key from a bad network here.
   */
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (message: string) => void): void;
}

export type OpenDeepgramSocket = (url: string, headers: Record<string, string>) => DeepgramSocket;

/** Wraps Node's global `WebSocket`. Production's only implementation. */
export function createWebSocketOpener(): OpenDeepgramSocket {
  return (url, headers) => {
    const socket = new WebSocket(url, { headers });

    return {
      send(data) {
        socket.send(data);
      },
      close() {
        // No code/reason: undici rejects any code outside 1000 and 3000-4999,
        // and Deepgram derives everything it needs from the `CloseStream`
        // message already sent ahead of this.
        socket.close();
      },
      onOpen(handler) {
        socket.addEventListener('open', () => handler());
      },
      onMessage(handler) {
        socket.addEventListener('message', (event: MessageEvent) => {
          if (typeof event.data === 'string') handler(event.data);
        });
      },
      onClose(handler) {
        socket.addEventListener('close', (event: CloseEvent) => {
          handler(event.code, event.reason);
        });
      },
      onError(handler) {
        // undici's error event carries no useful detail by design (it would
        // leak cross-origin information in a browser). The close that follows
        // is what actually drives the reconnect; this exists so a listener is
        // always attached and an error can never surface as an unhandled one.
        socket.addEventListener('error', () => handler('The transcription socket errored.'));
      },
    };
  };
}
