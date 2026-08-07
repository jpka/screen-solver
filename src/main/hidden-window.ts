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
 *
 * Not yet wired here: the spec's "renderer crash → auto-restart, escalating
 * on repeat" (#32's failure taxonomy). `src/host/capture/crash-restart-policy.ts`
 * has the pure, unit-tested escalation ladder (when to restart, how long to
 * back off, when to give up) ready for a `webContents.on('render-process-gone', ...)`
 * listener to drive by re-calling {@link createHiddenWindow} and re-pointing
 * whatever holds the current window reference (`src/main/index.ts`'s
 * `hiddenWindowReady`, `capture-session.ts`'s open sessions) at the new one.
 * Left undone because it needs a real renderer crash to verify against, the
 * same manual/E2E-only territory `minimized-check.ts` and
 * `window-enumeration.ts` are already in for their own Windows-only
 * mechanism -- #32's own acceptance criteria explicitly sanction a
 * documented manual step here rather than an unverifiable automated one.
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
