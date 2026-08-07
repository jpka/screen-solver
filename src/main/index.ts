import { app, type BrowserWindow } from 'electron';
import { bootstrapHost, type StartedHost } from '../host/bootstrap.ts';
import { isStartupError } from '../host/errors.ts';
import { consoleLogger } from '../host/logger.ts';
import { createRealCaptureSessionOpener } from './capture-session.ts';
import { createHiddenWindow } from './hidden-window.ts';
import { isTargetMinimizedReal } from './minimized-check.ts';
import { enumerateOpenWindows } from './window-enumeration.ts';

const EXIT_OK = 0;
const EXIT_REFUSED_TO_START = 1;

/**
 * Pins the state root to `%APPDATA%\screen-solver\` per the spec.
 *
 * Electron otherwise derives the app name from whatever directory it was
 * handed, which falls back to "Electron" when the entry point is passed as a
 * bare file path. Must run before the first `getPath('userData')`, and it also
 * keys `requestSingleInstanceLock()`.
 */
app.setName('screen-solver');

/**
 * The Electron entry point, kept deliberately thin.
 *
 * Everything decision-shaped lives in `src/host/`, which knows nothing about
 * Electron and is therefore testable in plain Node. This file only supplies the
 * three things that genuinely need Electron — the userData path, the
 * single-instance lock, and the hidden renderer — and translates a refusal to
 * start into a message and an exit code.
 */
async function main(): Promise<void> {
  // Resolved once the hidden renderer actually exists (below, after
  // `app.whenReady()`). `bootstrapHost` may start a capture session before
  // that point if a target is already configured (#30's "open at startup"
  // rule) -- `createRealCaptureSessionOpener` awaits this rather than
  // requiring the window up front, so that doesn't deadlock or force the
  // window to be created before the API key is out of `process.env`.
  let hiddenWindowCreated: (window: BrowserWindow) => void;
  const hiddenWindowReady = new Promise<BrowserWindow>((resolve) => {
    hiddenWindowCreated = resolve;
  });

  const result = await bootstrapHost({
    env: process.env,
    stateRoot: app.getPath('userData'),
    acquireInstanceLock: () => app.requestSingleInstanceLock(),
    logger: consoleLogger,
    enumerateWindows: enumerateOpenWindows,
    openCaptureSession: createRealCaptureSessionOpener(hiddenWindowReady),
    isTargetMinimized: isTargetMinimizedReal,
  });

  if (result.status === 'already-running') {
    consoleLogger.info(
      'Screen Solver is already running against this state root. Leaving the running instance alone.',
    );
    app.exit(EXIT_OK);
    return;
  }

  const host: StartedHost = result.host;

  // A second launch releases its lock and exits; there is no visible window to
  // focus, so this handler exists purely to make that a documented no-op.
  app.on('second-instance', () => {
    consoleLogger.info('A second Screen Solver launch was refused; this instance keeps running.');
  });

  // The only window is hidden and never closed by a user. Without this, losing
  // it would silently quit the whole host.
  app.on('window-all-closed', () => {});

  let shuttingDown = false;
  app.on('before-quit', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void host.shutdown().catch(() => {});
  });

  await app.whenReady();
  hiddenWindowCreated!(await createHiddenWindow());
}

main().catch((error: unknown) => {
  if (isStartupError(error)) {
    console.error(`\nScreen Solver could not start.\n\n${error.message}\n`);
  } else {
    console.error('\nScreen Solver could not start.\n');
    console.error(error);
  }
  app.exit(EXIT_REFUSED_TO_START);
});
