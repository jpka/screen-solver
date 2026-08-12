import { desktopCapturer, ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import type { AudioCapture, AudioChunkSink, OpenAudioCapture } from '../host/audio/types.ts';
import { consoleLogger } from '../host/logger.ts';
import { AUDIO_CHANNELS, type AudioChunkMessage, type AudioStatusMessage } from './audio-ipc-channels.ts';

/**
 * A renderer that never answers a `start` (crashed, wedged, or sitting on a
 * `getDisplayMedia` prompt that will never resolve) must not leave the
 * recording coordinator in `'starting'` forever. Same reasoning as
 * `capture-session.ts`'s `FRAME_REQUEST_TIMEOUT_MS`, and generous for the same
 * reason: the happy path here is a device grab plus an `AudioWorklet` module
 * load, both of which are fast but neither of which is instant.
 */
const AUDIO_START_TIMEOUT_MS = 10_000;

/**
 * Tracks which windows already have the display-media handler installed.
 *
 * Installing it twice would merely *replace* the previous one (Electron keeps
 * a single handler per session, not a list), so a duplicate install is
 * harmless rather than a leak -- but "harmless" is only true as long as both
 * installs are this same function. Guarding makes repeated
 * start/stop/start cycles a genuine no-op here instead of something whose
 * safety depends on the two closures being identical.
 *
 * Keyed weakly on the window so a re-created hidden renderer (the crash-restart
 * path `hidden-window.ts` describes) gets its own handler rather than
 * inheriting a stale "already installed" flag.
 */
const displayMediaHandlerInstalled = new WeakSet<BrowserWindow>();

/**
 * Builds the real, Windows-loopback-backed `OpenAudioCapture`, wired into
 * `bootstrapHost` from `src/main/index.ts` next to `openCaptureSession`.
 *
 * `hiddenWindowReady` is a promise rather than an already-created
 * `BrowserWindow` for exactly the reason `createRealCaptureSessionOpener`
 * documents at length: the hidden renderer can only be created *after*
 * `bootstrapHost` has deleted `ANTHROPIC_API_KEY` from `process.env`, but the
 * opener has to be handed to `bootstrapHost` before that. Awaiting a
 * not-yet-resolved promise lets both orderings hold at once. It matters less
 * here than it does for capture -- recording is off on every launch, so
 * nothing calls this during `bootstrapHost` -- but taking the window any other
 * way would mean `index.ts` had two different wiring shapes for the same
 * problem.
 *
 * Mechanism only, per `src/main`'s "nothing to decide here" rule: what to do
 * with a chunk, when to start, when to give up, and what a failure means to
 * the user all live in `src/host/audio/`.
 */
export function createRealAudioCaptureOpener(
  hiddenWindowReady: Promise<BrowserWindow>,
): OpenAudioCapture {
  return async (sink: AudioChunkSink): Promise<AudioCapture> => {
    const window = await hiddenWindowReady;
    installLoopbackDisplayMediaHandler(window);

    /**
     * Set by whoever currently cares about a status message: first the
     * start handshake below, then (once that has settled) a plain log line,
     * since `AudioCapture` has no channel to report a mid-session failure on.
     */
    let onStatus: (message: AudioStatusMessage) => void = () => {};

    function chunkListener(
      event: IpcMainEvent,
      channel: AudioChunkMessage['channel'],
      pcm: AudioChunkMessage['pcm'],
    ): void {
      if (event.sender !== window.webContents) return;
      sink({ channel, pcm: new Uint8Array(Buffer.from(pcm)) });
    }

    function statusListener(event: IpcMainEvent, message: AudioStatusMessage): void {
      if (event.sender !== window.webContents) return;
      onStatus(message);
    }

    // `ipcMain` listeners are process-global and outlive any one session.
    // `capture-session.ts` gets away without bookkeeping because each of its
    // listeners is registered per `captureFrame()` call and removed as soon as
    // that call's reply (or timeout) lands. These two are a subscription that
    // lives as long as the session does, so every one of them that isn't
    // removed on `close()` is a leak: the next session's chunks would be
    // delivered to this session's `sink` as well, and `EventEmitter` would
    // eventually start warning about the pile-up.
    ipcMain.on(AUDIO_CHANNELS.chunk, chunkListener);
    ipcMain.on(AUDIO_CHANNELS.status, statusListener);

    function removeListeners(): void {
      ipcMain.removeListener(AUDIO_CHANNELS.chunk, chunkListener);
      ipcMain.removeListener(AUDIO_CHANNELS.status, statusListener);
    }

    const started = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting ${AUDIO_START_TIMEOUT_MS}ms for the hidden renderer to start audio capture.`,
          ),
        );
      }, AUDIO_START_TIMEOUT_MS);

      onStatus = (message) => {
        clearTimeout(timeout);
        // Anything after the handshake is informational: the session is
        // already open as far as the coordinator is concerned.
        onStatus = logLateStatus;
        if (message.state === 'started') resolve();
        else reject(new Error(`Audio capture failed to start: ${message.reason}`));
      };
    });

    send(window, AUDIO_CHANNELS.start);

    try {
      await started;
    } catch (error) {
      // Nothing here is half-open from the coordinator's point of view -- it
      // gets a rejection and goes to `'error'` -- but the renderer may still
      // have built part of a graph before giving up, so tell it to drop
      // whatever it has. `stop` is idempotent on that side.
      removeListeners();
      send(window, AUDIO_CHANNELS.stop);
      throw error;
    }

    let closed = false;
    return {
      async close(): Promise<void> {
        // `closeEverything()` in the coordinator is reachable from both
        // `stop()` and the shutdown drain; closing twice must not send a
        // second `stop` or double-remove listeners.
        if (closed) return;
        closed = true;
        removeListeners();
        send(window, AUDIO_CHANNELS.stop);
      },
    };
  };
}

/**
 * Points the hidden renderer's `getDisplayMedia` at the system's render
 * loopback.
 *
 * Installed on the hidden window's **own** session (`webContents.session`),
 * not `defaultSession`: this handler unconditionally hands out screen +
 * loopback audio with no prompt, which is only acceptable because the exact
 * page asking for it is one we wrote and loaded from disk. Scoping it to that
 * window's session keeps it from applying to any other `WebContents` this app
 * might ever create; the `request.frame` check narrows it further to that
 * window's main frame rather than any subframe it might one day load.
 *
 * `audio: 'loopback'` rather than `'loopbackWithMute'`: the point of this
 * feature is transcribing a meeting the user is *listening to*, so silencing
 * their speakers to capture it would defeat it entirely.
 *
 * A video source has to be offered even though the renderer stops the video
 * track the instant it arrives -- see `static/renderer/audio.js` for why
 * audio-only is not an option here.
 */
function installLoopbackDisplayMediaHandler(window: BrowserWindow): void {
  if (displayMediaHandlerInstalled.has(window)) return;
  displayMediaHandlerInstalled.add(window);

  window.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== window.webContents.mainFrame) {
      callback({});
      return;
    }

    const [screen] = await desktopCapturer.getSources({ types: ['screen'] });
    if (screen === undefined) {
      // No screen to attach the (mandatory, immediately-discarded) video
      // track to. Denying makes `getDisplayMedia` reject, which the renderer
      // turns into a `failed` status rather than a silent stall.
      callback({});
      return;
    }

    callback({ video: screen, audio: 'loopback' });
  });
}

function logLateStatus(message: AudioStatusMessage): void {
  if (message.state === 'started') return;
  consoleLogger.error(
    `transcript: the hidden renderer reported an audio capture failure after start: ${message.reason}`,
  );
}

/**
 * A send that tolerates an already-destroyed renderer.
 *
 * `close()` runs on the shutdown path and on the renderer-crash path, both of
 * which can find the `webContents` gone; `send` throws outright on a destroyed
 * one. Swallowing that is right here because the message is always "stop
 * producing audio", and a renderer that no longer exists has already complied.
 */
function send(window: BrowserWindow, channel: string): void {
  if (window.isDestroyed()) return;
  window.webContents.send(channel);
}
