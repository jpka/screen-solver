import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import type {
  OpenRecorder,
  OpenRecorderOptions,
  Recorder,
  SegmentId,
} from '../host/screen-recording/types.ts';
import {
  SCREEN_RECORDING_CHANNELS,
  type ScreenRecordingChunkMessage,
  type ScreenRecordingStatusMessage,
} from './screen-recording-ipc-channels.ts';

/**
 * A renderer that never answers a `start` (crashed, wedged, or stuck
 * negotiating a `MediaRecorder` mime type) must not leave the caller waiting
 * on `createRealScreenRecorderOpener`'s returned promise forever. Same reasoning as
 * `capture-session.ts`'s `FRAME_REQUEST_TIMEOUT_MS`, and reused below for
 * `roll()`'s own handshake and `close()`'s bounded wait for `stopped`: none of
 * these round trips should be able to hang the caller past a fixed budget,
 * even though the happy path (constructing/tearing down a `MediaRecorder`) is
 * normally near-instant.
 */
const RECORDING_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Builds the real `OpenRecorder`, wired into `bootstrapHost` from
 * `src/main/index.ts` alongside `createRealCaptureSessionOpener`.
 *
 * `hiddenWindowReady` is a promise rather than an already-created
 * `BrowserWindow` for exactly the reason `createRealCaptureSessionOpener`
 * documents at length: the hidden renderer can only be created *after*
 * `bootstrapHost` has deleted `ANTHROPIC_API_KEY` from `process.env`, so it
 * never inherits it, but the opener has to be handed to `bootstrapHost`
 * before that deletion (and the window's creation) has happened. Awaiting a
 * not-yet-resolved promise here lets both orderings hold at once: whoever in
 * `src/host/recording` decides to start recording can call this opener
 * without caring whether the window already exists, and the actual `start`
 * message goes out the moment `index.ts` creates the window and resolves this
 * promise.
 *
 * Mechanism only, per `src/main`'s "nothing to decide here" rule: whether to
 * record at all, when a segment should roll, and what a failure means to the
 * user all live in `src/host/screen-recording/`. This file only relays messages
 * across the IPC boundary and turns them into the `Recorder` shape
 * `src/host/screen-recording/types.ts` defines.
 */
export function createRealScreenRecorderOpener(hiddenWindowReady: Promise<BrowserWindow>): OpenRecorder {
  return async (options: OpenRecorderOptions): Promise<Recorder> => {
    const window = await hiddenWindowReady;
    const { segmentId, sink, onFailure, timesliceMs } = options;

    // Routes every `status` message to whichever step currently cares about
    // it: first the start handshake below, then (once that settles) the
    // live-session router that resolves `roll()` and reports async failures.
    let onStatus: (message: ScreenRecordingStatusMessage) => void = () => {};

    function chunkListener(event: IpcMainEvent, message: ScreenRecordingChunkMessage): void {
      if (event.sender !== window.webContents) return;
      const bytes = Buffer.from(message.bytesBase64, 'base64');
      sink({ segmentId: message.segmentId, bytes: new Uint8Array(bytes), last: message.last });
    }

    function statusListener(event: IpcMainEvent, message: ScreenRecordingStatusMessage): void {
      if (event.sender !== window.webContents) return;
      onStatus(message);
    }

    // `ipcMain` listeners are process-global and outlive any one call.
    // `capture-session.ts` gets away without bookkeeping because each of its
    // listeners is registered per `captureFrame()` request and removed as
    // soon as that request's reply (or timeout) lands. These two are a
    // *subscription* that lives as long as the recording session does — one
    // `start` produces an unbounded stream of `chunk`/`status` messages until
    // a `stop` — so every one of them that isn't removed on `close()` (or on
    // a failed start) is a leak: the next session's chunks would be delivered
    // to this session's `sink` as well, on top of `EventEmitter` eventually
    // warning about the pile-up of listeners on a process-global emitter.
    ipcMain.on(SCREEN_RECORDING_CHANNELS.chunk, chunkListener);
    ipcMain.on(SCREEN_RECORDING_CHANNELS.status, statusListener);

    function removeListeners(): void {
      ipcMain.removeListener(SCREEN_RECORDING_CHANNELS.chunk, chunkListener);
      ipcMain.removeListener(SCREEN_RECORDING_CHANNELS.status, statusListener);
    }

    const started = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting ${RECORDING_HANDSHAKE_TIMEOUT_MS}ms for the hidden renderer to start recording.`,
          ),
        );
      }, RECORDING_HANDSHAKE_TIMEOUT_MS);

      onStatus = (message) => {
        clearTimeout(timeout);
        if (message.state === 'started') {
          resolve(message.mimeType);
        } else if (message.state === 'failed') {
          reject(new Error(`Recording failed to start: ${message.reason}`));
        } else {
          // 'rolled'/'stopped' before a 'started' is not a handshake this
          // opener ever asked for; treat it the same as a failure rather
          // than resolving on the wrong signal.
          reject(new Error(`Unexpected status "${message.state}" while starting recording.`));
        }
      };
    });

    send(window, SCREEN_RECORDING_CHANNELS.start, segmentId, timesliceMs);

    let mimeType: string;
    try {
      mimeType = await started;
    } catch (error) {
      // Nothing here is half-open from the caller's point of view -- it gets
      // a rejection and never receives a `Recorder` -- but the renderer may
      // still have built part of a `MediaRecorder` before giving up, so tell
      // it to drop whatever it has. `stop` is idempotent on that side.
      removeListeners();
      send(window, SCREEN_RECORDING_CHANNELS.stop);
      throw error;
    }

    // The one `roll()` call allowed to be outstanding at a time, resolved or
    // rejected by the live-session status router below. `Recorder.roll()`
    // itself only ever awaits one call before starting the next, so there is
    // never more than one of these in flight.
    let pendingRoll: {
      readonly segmentId: SegmentId;
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
    } | null = null;

    onStatus = (message) => {
      if (message.state === 'rolled') {
        if (pendingRoll !== null && pendingRoll.segmentId === message.segmentId) {
          pendingRoll.resolve();
          pendingRoll = null;
        }
        return;
      }
      if (message.state === 'failed') {
        if (pendingRoll !== null) {
          pendingRoll.reject(new Error(`Recording failed while rolling: ${message.reason}`));
          pendingRoll = null;
        }
        // A failure after the handshake has no outstanding call to reject --
        // `RecorderFailure`'s doc comment on this exact point -- so it goes
        // to the caller-supplied `onFailure` callback instead.
        onFailure({ reason: message.reason });
        return;
      }
      // 'started'/'stopped' outside their expected windows (handshake,
      // close()) are stale or duplicate signals; nothing to do with them.
    };

    let closed = false;

    return {
      mimeType,

      async roll(next: SegmentId): Promise<void> {
        if (closed) {
          throw new Error('Cannot roll a recorder that has already been closed.');
        }
        return new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingRoll = null;
            reject(
              new Error(
                `Timed out waiting ${RECORDING_HANDSHAKE_TIMEOUT_MS}ms for the hidden renderer to roll to segment "${next}".`,
              ),
            );
          }, RECORDING_HANDSHAKE_TIMEOUT_MS);

          pendingRoll = {
            segmentId: next,
            resolve: () => {
              clearTimeout(timeout);
              resolve();
            },
            reject: (error) => {
              clearTimeout(timeout);
              reject(error);
            },
          };

          send(window, SCREEN_RECORDING_CHANNELS.roll, next);
        });
      },

      async close(): Promise<void> {
        // Reachable from both a deliberate stop and the shutdown drain;
        // closing twice must not send a second `stop` or double-remove
        // listeners still relied on by the first call's in-flight wait.
        if (closed) return;
        closed = true;

        try {
          await new Promise<void>((resolve) => {
            // Bounded: a wedged or already-gone renderer must not hang
            // shutdown waiting for a `stopped` that will never arrive.
            const timeout = setTimeout(() => resolve(), RECORDING_HANDSHAKE_TIMEOUT_MS);

            onStatus = (message) => {
              if (message.state === 'stopped') {
                clearTimeout(timeout);
                resolve();
              }
              // Anything else arriving after `stop` was sent is stale;
              // `close()` only cares about the one `stopped` reply.
            };

            send(window, SCREEN_RECORDING_CHANNELS.stop);
          });
        } finally {
          // Runs even when the wait above hit its timeout, so a wedged
          // renderer still gets cleaned up on this side instead of leaking
          // these listeners for the lifetime of the process.
          removeListeners();
        }
      },
    };
  };
}

/**
 * A send that tolerates an already-destroyed renderer.
 *
 * `close()` runs on the shutdown path and on the renderer-crash path, both of
 * which can find the `webContents` gone; `send` throws outright on a
 * destroyed one. Swallowing that here is right because every message this
 * file sends is either "stop" or a request the renderer can no longer answer
 * either way -- a renderer that no longer exists has already complied.
 */
function send(window: BrowserWindow, channel: string, ...args: readonly unknown[]): void {
  if (window.isDestroyed()) return;
  window.webContents.send(channel, ...args);
}
