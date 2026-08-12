import type { TranscriptChannel } from '../host/audio/types.ts';

/**
 * The IPC channel names `audio-capture.ts` (runs in main) uses to talk to the
 * hidden renderer's loopback-recording mechanism.
 *
 * A separate module from `capture-ipc-channels.ts` rather than four more keys
 * on `CAPTURE_CHANNELS`, because the two surfaces have nothing in common
 * beyond both being IPC:
 *
 * - **Lifecycle.** A capture session follows the configured target window and
 *   is opened at startup; a recording session follows an explicit client
 *   toggle and is off on every launch (`audio/recording-coordinator.ts`).
 * - **Cardinality.** Capture is request/reply -- one `requestFrame` push, one
 *   `frameResult` reply, correlated by a request id. Recording is a long-lived
 *   subscription: one `start`, then ~10 unsolicited `chunk` messages a second
 *   until `stop`.
 * - **Payload.** See {@link AUDIO_CHANNELS.chunk} below.
 *
 * `static/renderer/preload.js` and `static/renderer/audio.js` -- the two files
 * on the other end of these channels -- duplicate these four strings by hand
 * rather than importing this file, exactly as the capture four already are:
 * they're plain JavaScript loaded as-is (see `AGENTS.md`), not compiled by
 * `tsc`, so nothing under `static/` can `import`/`require` a module from
 * `src/`. Keep the two copies in sync if a channel name ever changes.
 */
export const AUDIO_CHANNELS = {
  /** main -> renderer, fire-and-forget: start loopback capture and keep chunks coming. */
  start: 'screen-solver:audio:start',
  /** main -> renderer, fire-and-forget: tear down whatever capture is running. */
  stop: 'screen-solver:audio:stop',
  /**
   * renderer -> main: one ~100 ms block of PCM, as `(channel, ArrayBuffer)`.
   *
   * Raw `ArrayBuffer` over structured clone, **not** base64 -- deliberately
   * the opposite call from `CaptureFrameMessage`, and the reason is traffic
   * shape rather than a change of mind. That comment's base64 choice was
   * right for its case: a ~1 MB frame a few times a minute, where a 33% size
   * penalty buys cheap insurance against typed-array views behaving
   * unpredictably across the context-isolation boundary. Audio is the
   * inverted case -- a continuous ~10 messages/second stream, forever, at
   * 3200 bytes each -- so that same insurance premium is now paid ten times a
   * second, and it buys two string transcodes (`btoa` in the renderer,
   * `Buffer.from(..., 'base64')` in main) plus `capture.js`'s
   * `String.fromCharCode.apply` chunking dance on every single message.
   *
   * The hedge is also unnecessary here: what's ambiguous across the boundary
   * is a typed-array *view* (a `Uint8Array` carries a byteOffset/length into
   * a buffer that may or may not survive the trip intact). A plain
   * `ArrayBuffer` has none of that -- it is natively supported by both
   * `contextBridge`'s and `ipcRenderer`'s structured clone, and main turns it
   * back into a `Uint8Array` in one step. So: send the buffer, not a view of
   * it, and not a string.
   */
  chunk: 'screen-solver:audio:chunk',
  /** renderer -> main: whether `start` actually produced a running graph. */
  status: 'screen-solver:audio:status',
} as const;

/** The `(channel, pcm)` pair the renderer sends on {@link AUDIO_CHANNELS.chunk}. */
export interface AudioChunkMessage {
  /** Which stream these bytes came from -- always `'them'` today; see `TranscriptChannel`. */
  readonly channel: TranscriptChannel;
  /** 16 kHz mono signed-16-bit little-endian PCM, 3200 bytes (~100 ms) per message. */
  readonly pcm: ArrayBuffer;
}

/**
 * What the renderer reports once, in response to a `start`.
 *
 * `'failed'` is what turns a renderer-side problem (no loopback device, a
 * `getDisplayMedia` rejection, a worklet that wouldn't load) into a rejected
 * `openAudioCapture` promise, which `audio/recording-coordinator.ts` already
 * catches and reports as `'error'`. Without it a failed start would look
 * exactly like a silent one: a session in `'starting'` that never receives a
 * byte.
 */
export type AudioStatusMessage =
  | { readonly state: 'started' }
  | { readonly state: 'failed'; readonly reason: string };
