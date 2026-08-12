/**
 * The IPC channel names `recording.ts` (runs in main) uses to talk to the
 * hidden renderer's `MediaRecorder` (#45).
 *
 * Same hand-duplication rule as `capture-ipc-channels.ts`:
 * `static/renderer/preload.js` and `static/renderer/capture.js` copy these
 * strings literally rather than importing this file, because nothing under
 * `static/` can reach a module under `src/`. Keep the copies in sync by hand.
 *
 * Note the asymmetry with the capture channels: those are request/reply, one
 * reply per request, correlated by a request id. These are a *subscription* —
 * one `start` produces an unbounded stream of `chunk` messages until a `stop`.
 * That difference is why `recording.ts` has to remove its `ipcMain` listeners
 * on close and `capture-session.ts` doesn't (its listeners are per-request and
 * self-removing).
 */
export const RECORDING_CHANNELS = {
  /** main -> renderer: begin recording the open capture stream into `segmentId`. */
  start: 'screen-solver:recording:start',
  /** main -> renderer: finish the current segment and begin the supplied one. */
  roll: 'screen-solver:recording:roll',
  /** main -> renderer: flush the final chunk and tear the recorder down. */
  stop: 'screen-solver:recording:stop',
  /** renderer -> main: one `dataavailable` payload, tagged with its segment. */
  chunk: 'screen-solver:recording:chunk',
  /** renderer -> main: lifecycle and failure reports (see {@link RecordingStatusMessage}). */
  status: 'screen-solver:recording:status',
} as const;

/**
 * One `dataavailable` payload on its way to main.
 *
 * `bytesBase64` rather than a `Uint8Array` for the reason
 * `capture-ipc-channels.ts` already documents: `send` structured-clones its
 * payload, which handles a string trivially and typed arrays less predictably
 * across the context-isolation boundary. The ~33% size premium is bounded here
 * by the timeslice — at one chunk per second of a downscaled window capture
 * this is tens to low hundreds of KB per message, not a whole recording.
 */
export interface RecordingChunkMessage {
  readonly segmentId: string;
  readonly bytesBase64: string;
  /** `true` for the flush produced by stopping this segment's `MediaRecorder`. */
  readonly last: boolean;
}

/**
 * The renderer's out-of-band lifecycle reports.
 *
 * `started` carries the negotiated `mimeType` because only the renderer can
 * ask `MediaRecorder.isTypeSupported`, and main needs it to name files and
 * serve the right `content-type`. `rolled` acknowledges a roll so
 * `Recorder.roll()` can resolve on the real event rather than optimistically.
 * `failed` is the only channel a mid-session failure has — by then there is no
 * outstanding call left to reject.
 */
export type RecordingStatusMessage =
  | { readonly state: 'started'; readonly mimeType: string }
  | { readonly state: 'rolled'; readonly segmentId: string }
  | { readonly state: 'stopped' }
  | { readonly state: 'failed'; readonly reason: string };
