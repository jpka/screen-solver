import type { Logger } from '../logger.ts';
import type { Secret } from '../secret.ts';
import {
  CLOSE_CODE_AUDIO_REJECTED,
  DEEPGRAM_MODEL,
  SAMPLE_RATE_HZ,
  authHeaders,
  createWebSocketOpener,
  listenUrl,
  type DeepgramMessage,
  type DeepgramSocket,
  type OpenDeepgramSocket,
} from './deepgram-transport.ts';
import { createReconnectPolicy } from './reconnect-policy.ts';
import type { Transcriber, TranscriberStream, TranscriberStreamOptions } from './types.ts';

/**
 * The Deepgram implementation of the transcription seam.
 *
 * It wraps one live socket per channel and nothing else — no capture, no
 * persistence, no HTTP server, no knowledge of recording sessions. Everything
 * it needs arrives through {@link DeepgramTranscriberConfig}, which is what
 * lets the whole module be exercised against a fake socket with no network.
 */

/**
 * Deepgram closes an idle socket after 10s of silence on the wire. 4s leaves
 * room for one missed tick without ever tripping it, and the timer is reset by
 * outbound audio — there is no point keeping a connection alive by hand while
 * real bytes are already flowing through it.
 */
export const KEEPALIVE_INTERVAL_MS = 4_000;

/**
 * How long {@link TranscriberStream.close} waits for the trailing finals that
 * `CloseStream` flushes before closing anyway.
 *
 * Bounded internally rather than by the caller because shutdown composes this
 * *inside* `bootstrap.ts`'s single 5s drain, alongside the in-flight solve and
 * both JSONL drains. A close that could hang would eat that entire budget and
 * cost the answer log its last line — a strictly worse trade than losing the
 * last second of speech.
 */
export const CLOSE_TIMEOUT_MS = 1_500;

/**
 * The bounded reconnect buffer: 10 seconds of 16 kHz mono PCM16 (320 KB).
 *
 * Deliberately small. Replaying a five-minute outage in full would bill five
 * minutes of streaming *and* deliver five minutes of transcript out of
 * wall-clock order, arriving all at once long after the moment it describes.
 * Ten seconds absorbs an ordinary Wi-Fi blip with no visible distortion; past
 * that, an honest gap in the transcript is the better failure.
 */
export const MAX_BUFFERED_BYTES = SAMPLE_RATE_HZ * 2 * 10;

/** Deepgram's own HTTP surface, used only for the key pre-flight below. */
export const DEFAULT_AUTH_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';

export interface DeepgramTranscriberConfig {
  /** Host-process only; revealed once per socket, inside the transport. */
  readonly apiKey: Secret;
  /** Injected by tests. Production leaves it unset and gets the real socket. */
  readonly openSocket?: OpenDeepgramSocket;
  /** Injected by tests; production uses global `fetch` for the pre-flight. */
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly authGrantUrl?: string;
  readonly reconnectDelaysMs?: readonly number[];
  readonly healthyConnectionMs?: number;
  readonly keepaliveIntervalMs?: number;
  readonly closeTimeoutMs?: number;
  readonly maxBufferedBytes?: number;
  readonly logger?: Logger;
}

export function createDeepgramTranscriber(config: DeepgramTranscriberConfig): Transcriber {
  const openSocket = config.openSocket ?? createWebSocketOpener();
  const doFetch = config.fetch ?? globalThis.fetch;
  const url = listenUrl(config.baseUrl);
  const authGrantUrl = config.authGrantUrl ?? DEFAULT_AUTH_GRANT_URL;
  const keepaliveIntervalMs = config.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  const closeTimeoutMs = config.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  const maxBufferedBytes = config.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const log = config.logger;

  /**
   * Is this key usable at all?
   *
   * This exists because a WebSocket cannot tell us. Deepgram reports a
   * handshake rejection in a `dg-error` *response header*, and a
   * browser-style WebSocket — undici's included — only exposes response
   * headers on a successful upgrade. So a revoked key and a dead network
   * arrive at `onClose` looking exactly alike, and without this every auth
   * failure would be misfiled as `transient` and reconnected forever.
   *
   * Only a 401 is treated as fatal. A 403 is *not*: `/v1/auth/grant` requires
   * Member-or-higher authorization, so a perfectly good streaming-scoped key
   * can be refused by this endpoint while still being able to open a listen
   * socket. Refusing to record on a 403 would lock out a working key, which
   * is a worse error than attempting a socket that then fails on its own.
   * Everything else — 404, 500, a network error, this endpoint being retired
   * — also proceeds, which degrades this cleanly back to "no pre-flight at
   * all" rather than to a false refusal.
   */
  async function keyIsRejected(): Promise<boolean> {
    try {
      const response = await doFetch(authGrantUrl, {
        method: 'POST',
        headers: { ...authHeaders(config.apiKey), 'content-type': 'application/json' },
        body: '{}',
      });
      return response.status === 401;
    } catch {
      return false;
    }
  }

  function open(options: TranscriberStreamOptions): TranscriberStream {
    const { onEvent } = options;
    const policy = createReconnectPolicy({
      delaysMs: config.reconnectDelaysMs,
      healthyConnectionMs: config.healthyConnectionMs,
    });

    let socket: DeepgramSocket | null = null;
    /** True only between `onOpen` and `onClose` — the window in which `send` may touch the socket. */
    let live = false;
    let openedAtMs: number | null = null;
    let stopped = false;
    /** Set once `close()` is waiting on the socket's own close event. */
    let resolveClosed: (() => void) | null = null;

    let keepalive: NodeJS.Timeout | null = null;
    let reconnect: NodeJS.Timeout | null = null;

    const buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    let droppedBytes = 0;
    let warnedAboutDropping = false;

    function clearKeepalive(): void {
      if (keepalive !== null) {
        clearInterval(keepalive);
        keepalive = null;
      }
    }

    function armKeepalive(): void {
      clearKeepalive();
      keepalive = setInterval(() => {
        if (live && socket !== null) socket.send(JSON.stringify({ type: 'KeepAlive' }));
      }, keepaliveIntervalMs);
      // Never a reason for a keepalive tick to hold a quitting process — or a
      // finished `node --test` run — open.
      keepalive.unref?.();
    }

    function bufferChunk(pcm: Uint8Array): void {
      buffered.push(pcm);
      bufferedBytes += pcm.byteLength;
      while (bufferedBytes > maxBufferedBytes && buffered.length > 0) {
        const dropped = buffered.shift();
        if (dropped === undefined) break;
        bufferedBytes -= dropped.byteLength;
        droppedBytes += dropped.byteLength;
      }
      if (droppedBytes > 0 && !warnedAboutDropping) {
        warnedAboutDropping = true;
        log?.warn(
          `Transcription for "${options.channel}" is disconnected and the ${Math.round(
            maxBufferedBytes / (SAMPLE_RATE_HZ * 2),
          )}s audio buffer is full. Speech from this gap will be missing from the transcript.`,
        );
      }
    }

    function flushBuffer(): void {
      if (socket === null) return;
      for (const chunk of buffered) socket.send(chunk);
      buffered.length = 0;
      bufferedBytes = 0;
      droppedBytes = 0;
      warnedAboutDropping = false;
    }

    function handleMessage(raw: string): void {
      let message: DeepgramMessage;
      try {
        message = JSON.parse(raw) as DeepgramMessage;
      } catch {
        // A frame this module can't read is not worth ending a recording over.
        return;
      }

      const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
      // Deepgram emits empty transcripts across silence, as both interims and
      // finals. They carry no information and an empty final would otherwise
      // become an empty `transcript.jsonl` line.
      if (text === '') return;

      if (message.is_final === true) {
        const startSeconds = message.start ?? 0;
        onEvent({
          type: 'final',
          text,
          startSeconds,
          endSeconds: startSeconds + (message.duration ?? 0),
        });
        return;
      }
      onEvent({ type: 'interim', text });
    }

    function handleClose(code: number): void {
      clearKeepalive();
      live = false;
      const openDurationMs = openedAtMs === null ? 0 : Date.now() - openedAtMs;
      openedAtMs = null;
      socket = null;

      if (resolveClosed !== null) {
        const resolve = resolveClosed;
        resolveClosed = null;
        resolve();
        return;
      }
      if (stopped) return;

      if (code === CLOSE_CODE_AUDIO_REJECTED) {
        // Our own encoding parameters disagree with the bytes we sent. Another
        // socket would fail identically — the same call `anthropic.ts` makes
        // about a 400.
        stopped = true;
        onEvent({
          type: 'error',
          kind: 'audio-rejected',
          message:
            'Deepgram rejected the audio format. The PCM the renderer produces no longer ' +
            'matches the encoding declared in the listen URL.',
        });
        return;
      }

      const { delayMs, attempt } = policy.onDisconnect(openDurationMs);
      onEvent({ type: 'reconnecting', attempt });
      reconnect = setTimeout(() => {
        reconnect = null;
        if (!stopped) connect();
      }, delayMs);
      reconnect.unref?.();
    }

    function connect(): void {
      if (stopped) return;
      const next = openSocket(url, authHeaders(config.apiKey));
      socket = next;

      next.onOpen(() => {
        if (stopped || socket !== next) return;
        live = true;
        openedAtMs = Date.now();
        // Order matters: whatever accumulated during the outage goes out
        // before any newly-arriving chunk, so the transcript stays in order.
        flushBuffer();
        armKeepalive();
        onEvent({ type: 'open' });
      });
      next.onMessage((raw) => {
        if (socket === next) handleMessage(raw);
      });
      next.onClose((code) => {
        if (socket === next || socket === null) handleClose(code);
      });
      next.onError((message) => {
        // The close that follows is what drives the reconnect; this only makes
        // sure an error can never surface as an unhandled one.
        log?.warn(`Transcription socket for "${options.channel}": ${message}`);
      });
    }

    void (async () => {
      if (await keyIsRejected()) {
        stopped = true;
        onEvent({
          type: 'error',
          kind: 'auth',
          message: 'Deepgram rejected the API key. Recording is unavailable until it is replaced.',
        });
        return;
      }
      if (!stopped) connect();
    })();

    return {
      send(pcm) {
        if (stopped) return;
        if (live && socket !== null) {
          socket.send(pcm);
          return;
        }
        bufferChunk(pcm);
      },

      async close() {
        if (stopped) {
          clearKeepalive();
          return;
        }
        stopped = true;
        if (reconnect !== null) {
          clearTimeout(reconnect);
          reconnect = null;
        }
        clearKeepalive();

        const current = socket;
        if (current === null || !live) {
          current?.close();
          socket = null;
          return;
        }

        // `CloseStream` asks Deepgram to transcribe whatever it is still
        // holding and emit the trailing finals before closing. Those finals
        // are the last thing said before shutdown, so they are worth a short
        // wait — but only a short one.
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        current.send(JSON.stringify({ type: 'CloseStream' }));

        await Promise.race([closed, delay(closeTimeoutMs)]);
        resolveClosed = null;
        current.close();
        socket = null;
        live = false;
      },
    };
  }

  return Object.freeze({ model: DEEPGRAM_MODEL, open });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
