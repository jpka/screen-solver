/**
 * The IPC channel names `capture-session.ts` (runs in main) uses to talk to
 * the hidden renderer.
 *
 * `static/renderer/preload.js` and `static/renderer/capture.js` — the two
 * files actually on the other end of these channels — duplicate these four
 * strings by hand rather than importing this file: they're plain JavaScript
 * loaded/served as-is (see `AGENTS.md`), not compiled by `tsc`, so nothing
 * under `static/` can `import`/`require` a module from `src/`. Keep the two
 * copies in sync if a channel name ever changes.
 */
export const CAPTURE_CHANNELS = {
  /** main -> renderer, fire-and-forget: open a session against a `desktopCapturer` source id. */
  open: 'screen-solver:capture:open',
  /** main -> renderer, fire-and-forget: close whatever session is open. */
  close: 'screen-solver:capture:close',
  /** main -> renderer, fire-and-forget: grab and encode the current frame, tagged with a request id. */
  requestFrame: 'screen-solver:capture:request-frame',
  /** renderer -> main: the requested frame (or a failure reason), tagged with the same request id. */
  frameResult: 'screen-solver:capture:frame-result',
} as const;

/**
 * What the renderer sends back in response to a `requestFrame` message.
 *
 * Pixel and encoded bytes travel as base64 rather than raw binary: `send`
 * over Electron's IPC structured-clones its payload, which handles a plain
 * string trivially and a `Uint8Array`/`ArrayBuffer` less predictably across
 * the context-isolation boundary. Base64 costs ~33% more bytes for a frame
 * that's already downscaled to at most 1568px on a side -- cheap insurance.
 */
export type CaptureFrameMessage =
  | {
      readonly ok: true;
      readonly width: number;
      readonly height: number;
      readonly mediaType: string;
      /** The encoded (downscaled, no-crop) image, base64-encoded. */
      readonly bytesBase64: string;
      /** Raw RGBA pixel bytes of that same downscaled frame, base64-encoded -- input to the black/zero-size ratio check. */
      readonly pixelsBase64: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };
