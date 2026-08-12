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
// `contextIsolation: true`: it copies these functions into capture.js's main
// world without giving capture.js's own script any access to `ipcRenderer`,
// `require`, or anything else this file can see. Three inbound events (open,
// close, request-frame) and one outbound reply (frame-result), all
// capture-shaped, nothing else -- capture.js gets exactly this surface and
// nothing more.
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

// Mirrors src/main/recording-ipc-channels.ts (#45), for the same
// can't-import-across-static reason as CAPTURE_CHANNELS above. Keep these
// five strings in sync with recording-ipc-channels.ts by hand if either
// changes.
const RECORDING_CHANNELS = {
  start: 'screen-solver:recording:start',
  roll: 'screen-solver:recording:roll',
  stop: 'screen-solver:recording:stop',
  chunk: 'screen-solver:recording:chunk',
  status: 'screen-solver:recording:status',
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
// own lifecycle (#45's recording.ts note: "these are a subscription, not a
// per-request round trip" -- see recording-ipc-channels.ts) rather than
// another capture-shaped request/reply pair. Keeping the two surfaces
// separate also means capture.js's recording code can be read on its own
// without cross-referencing captureHost's request/reply shapes.
contextBridge.exposeInMainWorld('recordingHost', {
  /** Fires when main wants recording started against segmentId, at timesliceMs. */
  onStart(handler) {
    ipcRenderer.on(RECORDING_CHANNELS.start, (_event, segmentId, timesliceMs) => handler(segmentId, timesliceMs));
  },

  /** Fires when main wants the current segment finished and nextSegmentId begun. */
  onRoll(handler) {
    ipcRenderer.on(RECORDING_CHANNELS.roll, (_event, nextSegmentId) => handler(nextSegmentId));
  },

  /** Fires when main wants the open segment flushed and the recorder torn down. */
  onStop(handler) {
    ipcRenderer.on(RECORDING_CHANNELS.stop, () => handler());
  },

  /** Sends one dataavailable payload (base64 bytes, tagged with its segment) to main. */
  sendChunk(message) {
    ipcRenderer.send(RECORDING_CHANNELS.chunk, message);
  },

  /** Sends a lifecycle or failure report (started/rolled/stopped/failed) to main. */
  sendStatus(message) {
    ipcRenderer.send(RECORDING_CHANNELS.status, message);
  },
});
