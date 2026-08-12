// The hidden renderer's preload script (#30).
//
// Electron docs, "ESM in Electron": sandboxed preload scripts (hidden-window.ts
// sets `sandbox: true`) "run as plain JavaScript without an ESM context" --
// they are not loaded through Node's ESM/CJS resolution at all, so the
// project's `"type": "module"` and NodeNext module setup (everything else
// under src/) do not apply here. That is also why this file lives under
// static/renderer/ next to capture.js rather than under src/main/ compiled
// by tsc: a tsc-emitted `import` statement would be invalid syntax in the
// plain-script context a sandboxed preload actually runs in. `require` is
// what Electron polyfills for a sandboxed preload, restricted to a small set
// of safe built-ins plus 'electron' itself -- exactly what contextBridge and
// ipcRenderer need.
//
// `contextBridge.exposeInMainWorld` is what makes this safe under
// `contextIsolation: true`: it copies these functions into the page's main
// world without giving the page's own scripts any access to `ipcRenderer`,
// `require`, or anything else this file can see.
//
// Three surfaces, exposed separately rather than merged into one object:
// `window.captureHost` (#30) is three inbound events (open, close,
// request-frame) and one outbound reply (frame-result), all capture-shaped;
// `window.screenRecordingHost` (#47) is the video recorder's five;
// `window.audioHost` is the transcript pipeline's own four. They stay apart
// because the modules behind them do -- capture-ipc-channels.ts,
// screen-recording-ipc-channels.ts and audio-ipc-channels.ts are separate for
// reasons each spells out -- and because capture.js and audio.js should each
// see only what they use.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Mirrors src/main/capture-ipc-channels.ts. Duplicated, not imported: this
// file can't `require` a TypeScript module (or even a compiled one, without
// reaching outside static/, which is loaded/served as-is per AGENTS.md).
// Keep these four strings in sync with capture-ipc-channels.ts by hand if
// either changes.
const CAPTURE_CHANNELS = {
  open: 'screen-solver:capture:open',
  close: 'screen-solver:capture:close',
  requestFrame: 'screen-solver:capture:request-frame',
  frameResult: 'screen-solver:capture:frame-result',
};

// Mirrors src/main/screen-recording-ipc-channels.ts (#47), for the same
// can't-import-across-static reason as CAPTURE_CHANNELS above. Keep these
// five strings in sync with screen-recording-ipc-channels.ts by hand if either
// changes.
const SCREEN_RECORDING_CHANNELS = {
  start: 'screen-solver:screen-recording:start',
  roll: 'screen-solver:screen-recording:roll',
  stop: 'screen-solver:screen-recording:stop',
  chunk: 'screen-solver:screen-recording:chunk',
  status: 'screen-solver:screen-recording:status',
};

contextBridge.exposeInMainWorld('captureHost', {
  /** Fires when main wants a session opened against a desktopCapturer source id. */
  onOpen(handler) {
    ipcRenderer.on(CAPTURE_CHANNELS.open, (_event, sourceId) => handler(sourceId));
  },

  /** Fires when main wants whatever session is open torn down. */
  onClose(handler) {
    ipcRenderer.on(CAPTURE_CHANNELS.close, () => handler());
  },

  /**
   * Fires when main wants the current frame. `handler` does the actual grab
   * (mechanism only -- canvas, downscale, encode) and its resolved value is
   * sent back to main tagged with the same request id, so main can match the
   * reply to the request that triggered it.
   */
  onRequestFrame(handler) {
    ipcRenderer.on(CAPTURE_CHANNELS.requestFrame, (_event, requestId) => {
      Promise.resolve()
        .then(() => handler())
        .catch((error) => ({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        }))
        .then((message) => {
          ipcRenderer.send(CAPTURE_CHANNELS.frameResult, requestId, message);
        });
    });
  },
});

// A second exposeInMainWorld object, not more members bolted onto
// captureHost, because this is a genuinely separate subscription with its
// own lifecycle (#47's screen-recording.ts note: "these are a subscription, not a
// per-request round trip" -- see screen-recording-ipc-channels.ts) rather than
// another capture-shaped request/reply pair. Keeping the two surfaces
// separate also means capture.js's recording code can be read on its own
// without cross-referencing captureHost's request/reply shapes.
contextBridge.exposeInMainWorld('screenRecordingHost', {
  /** Fires when main wants recording started against segmentId, at timesliceMs. */
  onStart(handler) {
    ipcRenderer.on(SCREEN_RECORDING_CHANNELS.start, (_event, sessionId, segmentId, timesliceMs) =>
      handler(sessionId, segmentId, timesliceMs),
    );
  },

  /** Fires when main wants the current segment finished and nextSegmentId begun. */
  onRoll(handler) {
    ipcRenderer.on(SCREEN_RECORDING_CHANNELS.roll, (_event, sessionId, nextSegmentId) =>
      handler(sessionId, nextSegmentId),
    );
  },

  /** Fires when main wants the open segment flushed and the recorder torn down. */
  onStop(handler) {
    ipcRenderer.on(SCREEN_RECORDING_CHANNELS.stop, (_event, sessionId) => handler(sessionId));
  },

  /** Sends one dataavailable payload (base64 bytes, tagged with its segment) to main. */
  sendChunk(message) {
    ipcRenderer.send(SCREEN_RECORDING_CHANNELS.chunk, message);
  },

  /** Sends a lifecycle or failure report (started/rolled/stopped/failed) to main. */
  sendStatus(message) {
    ipcRenderer.send(SCREEN_RECORDING_CHANNELS.status, message);
  },
});

// Mirrors src/main/audio-ipc-channels.ts, duplicated by hand for the same
// reason CAPTURE_CHANNELS above is: nothing under static/ can require a
// module from src/, compiled or otherwise. Keep these four strings in sync
// with audio-ipc-channels.ts by hand if either changes.
const AUDIO_CHANNELS = {
  start: 'screen-solver:audio:start',
  stop: 'screen-solver:audio:stop',
  chunk: 'screen-solver:audio:chunk',
  status: 'screen-solver:audio:status',
};

contextBridge.exposeInMainWorld('audioHost', {
  /** Fires when main wants loopback capture running. */
  onStart(handler) {
    ipcRenderer.on(AUDIO_CHANNELS.start, () => handler());
  },

  /** Fires when main wants whatever capture is running torn down. */
  onStop(handler) {
    ipcRenderer.on(AUDIO_CHANNELS.stop, () => handler());
  },

  /**
   * Sends one ~100 ms block of 16 kHz signed-16 little-endian PCM to main.
   *
   * `pcm` is a plain `ArrayBuffer`, not a `Uint8Array` view and not base64 --
   * see src/main/audio-ipc-channels.ts for why this stream makes the opposite
   * call from capture.js's frames. Note that the buffer is *copied* twice on
   * the way out (once by contextBridge into this world, once by ipcRenderer's
   * own structured clone); the transfer list audio.js's worklet uses only
   * saves the copy from the audio thread. Two 3.2 KB memcpys ten times a
   * second is not worth a `postMessage` port to avoid.
   */
  sendChunk(channel, pcm) {
    ipcRenderer.send(AUDIO_CHANNELS.chunk, channel, pcm);
  },

  /**
   * Reports whether a `start` actually produced a running graph: 'started',
   * or 'failed' with a reason. Main turns a failure into a rejected
   * `openAudioCapture`, which is what lets the recording coordinator say
   * 'error' instead of sitting in 'starting' forever.
   */
  reportStatus(state, reason) {
    ipcRenderer.send(AUDIO_CHANNELS.status, { state, reason });
  },
});
