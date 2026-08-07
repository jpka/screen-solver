import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { classifyFrameQuality } from '../host/capture/frame-quality.ts';
import type {
  CapturedFrame,
  CaptureSession,
  OpenCaptureSession,
  TargetWindowIdentity,
} from '../host/capture/types.ts';
import type { ImageMediaType } from '../host/provider/types.ts';
import { CAPTURE_CHANNELS, type CaptureFrameMessage } from './capture-ipc-channels.ts';
import { findCaptureSourceId } from './window-enumeration.ts';

const SUPPORTED_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/** A renderer that never replies (crashed, wedged) must not hang a capture forever. */
const FRAME_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Builds the real, WGC-backed `OpenCaptureSession` (#30's window capture
 * decision — `desktopCapturer` -> `getUserMedia` in the hidden renderer, not
 * `PrintWindow`), wired into `bootstrapHost` from `src/main/index.ts`.
 *
 * `hiddenWindowReady` is a promise rather than an already-created
 * `BrowserWindow` because of an ordering constraint the rest of the app
 * already has to respect: the hidden renderer can only be created *after*
 * `bootstrapHost` has deleted `ANTHROPIC_API_KEY` from `process.env` (so the
 * renderer never inherits it — see `hidden-window.ts`), but the capture
 * session coordinator wants to open a session for an already-configured
 * target *during* `bootstrapHost`, before the HTTP bind even happens.
 * Awaiting a not-yet-resolved promise here — instead of requiring the window
 * to already exist — lets both orderings hold at once: `bootstrapHost` kicks
 * the coordinator off without blocking startup on it, and the actual open
 * proceeds the moment `index.ts` creates the window and resolves this
 * promise.
 */
export function createRealCaptureSessionOpener(
  hiddenWindowReady: Promise<BrowserWindow>,
): OpenCaptureSession {
  return async (target: TargetWindowIdentity): Promise<CaptureSession> => {
    const window = await hiddenWindowReady;
    const sourceId = await findCaptureSourceId(target);
    if (sourceId === null) {
      throw new Error(`No capturable window source found for ${target.processName} / "${target.title}"`);
    }

    window.webContents.send(CAPTURE_CHANNELS.open, sourceId);

    return {
      async captureFrame(): Promise<CapturedFrame> {
        const requestId = randomUUID();
        const resultPromise = waitForFrameResult(requestId);
        window.webContents.send(CAPTURE_CHANNELS.requestFrame, requestId);
        const message = await resultPromise;

        if (!message.ok) {
          throw new Error(`Capture failed: ${message.reason}`);
        }

        const bytes = Buffer.from(message.bytesBase64, 'base64');
        const pixels = Buffer.from(message.pixelsBase64, 'base64');
        const quality = classifyFrameQuality(pixels, message.width, message.height);

        return {
          mediaType: asSupportedMediaType(message.mediaType),
          bytes: new Uint8Array(bytes),
          width: message.width,
          height: message.height,
          quality,
        };
      },

      async close(): Promise<void> {
        window.webContents.send(CAPTURE_CHANNELS.close);
      },
    };
  };
}

/** Correlates a `requestFrame` push with its `frameResult` reply by request id. */
function waitForFrameResult(requestId: string): Promise<CaptureFrameMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener(CAPTURE_CHANNELS.frameResult, listener);
      reject(new Error(`Timed out waiting ${FRAME_REQUEST_TIMEOUT_MS}ms for a frame from the hidden renderer.`));
    }, FRAME_REQUEST_TIMEOUT_MS);

    function listener(_event: IpcMainEvent, id: string, message: CaptureFrameMessage): void {
      if (id !== requestId) return;
      clearTimeout(timeout);
      ipcMain.removeListener(CAPTURE_CHANNELS.frameResult, listener);
      resolve(message);
    }

    ipcMain.on(CAPTURE_CHANNELS.frameResult, listener);
  });
}

function asSupportedMediaType(value: string): ImageMediaType {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(value) ? (value as ImageMediaType) : 'image/jpeg';
}
