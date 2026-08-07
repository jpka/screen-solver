import { BrowserWindow } from 'electron';
import { hiddenRendererPage, hiddenRendererPreload } from './paths.ts';

/**
 * The one hidden `BrowserWindow`, never shown to the user.
 *
 * It exists to do mechanism the main process can't: turn a `desktopCapturer`
 * source into a live `MediaStream`, draw it to a canvas, downscale, encode
 * (#30). No decision logic runs here.
 *
 * Created only after {@link bootstrapHost} has already deleted the API key from
 * `process.env`, so the renderer cannot inherit it.
 *
 * `preload` is the narrow, explicit hole in `contextIsolation`/`sandbox` that
 * lets `static/renderer/capture.js` receive capture commands from main and
 * send frames back, without giving that page's own script any access to
 * Node, `require`, or the raw `ipcRenderer`/`electron` modules — see
 * `static/renderer/preload.js` for exactly what it exposes.
 */
export async function createHiddenWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A hidden window is by definition never visible; without this Chromium
      // throttles its timers and rAF, which would stall the capture pipeline.
      backgroundThrottling: false,
      preload: hiddenRendererPreload,
    },
  });

  await window.loadFile(hiddenRendererPage);
  return window;
}
