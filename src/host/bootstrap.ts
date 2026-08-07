import { API_KEY_ENV_VAR, takeApiKey } from './api-key.ts';
import { readHttpBinding, type HttpBinding } from './binding.ts';
import {
  startCaptureSessionCoordinator,
  type CaptureSessionCoordinator,
} from './capture/session-coordinator.ts';
import type { OpenCaptureSession } from './capture/types.ts';
import { loadConfigStore, type ConfigStore } from './config/store.ts';
import type { EnumerateWindows } from './config/types.ts';
import { createHostRoutes } from './http/routes.ts';
import type { Route } from './http/router.ts';
import {
  startHttpServer as defaultStartHttpServer,
  type ListeningHttpServer,
  type StartHttpServer,
} from './http/server.ts';
import type { Logger } from './logger.ts';
import type { Secret } from './secret.ts';
import { ensureStateRoot } from './state-root.ts';

/** No opener was injected. Nothing ever opens, which is a safe default for tests that don't care about capture. */
const NEVER_OPENS: OpenCaptureSession = () => Promise.reject(new Error('No capture session opener configured.'));

/**
 * Everything the startup sequence needs from the outside world.
 *
 * Electron supplies the real implementations (`app.getPath('userData')`,
 * `app.requestSingleInstanceLock()`); tests supply fakes and a temp directory.
 * Nothing in this module imports Electron, which is what keeps the startup
 * rules testable in plain Node.
 */
export interface HostRuntime {
  /** Mutated: the API key is deleted from it. Normally `process.env`. */
  readonly env: NodeJS.ProcessEnv;
  /** `app.getPath('userData')` — `%APPDATA%\screen-solver\`. */
  readonly stateRoot: string;
  /**
   * The single-instance guard. Electron's lock is keyed on the userData path,
   * so two checkouts pointed at the same state root are correctly one instance.
   * Returns false when another instance already holds the lock.
   */
  readonly acquireInstanceLock: () => boolean;
  readonly logger: Logger;
  readonly startHttpServer?: StartHttpServer;
  readonly routes?: readonly Route[];
  /**
   * Lists the windows a user could target (#28). Electron supplies the real
   * implementation (`src/main/window-enumeration.ts`); tests supply a fixed
   * fake list. Left unset, a saved target window always falls back to "no
   * target configured" on startup — safe for tests that don't care about
   * config.
   */
  readonly enumerateWindows?: EnumerateWindows;
  /**
   * Opens a live capture session for one target window (#30). Electron
   * supplies the real implementation (`src/main/capture-session.ts`); tests
   * supply a fake. Left unset, the capture session coordinator is
   * constructed but never actually opens anything — the same "safe default"
   * shape as `enumerateWindows`.
   */
  readonly openCaptureSession?: OpenCaptureSession;
}

/** The state the app lives in for the rest of its life. */
export interface StartedHost {
  readonly stateRoot: string;
  /** Host-process only. Never written to disk, sent over IPC, or logged. */
  readonly apiKey: Secret;
  readonly binding: HttpBinding;
  readonly server: ListeningHttpServer;
  /** #28's config surface: target window plus (reserved) provider selection, live-reloadable with no restart. */
  readonly configStore: ConfigStore;
  /** #30's capture session lifecycle: one session held open for the current target, reopened on every change. */
  readonly captureSessionCoordinator: CaptureSessionCoordinator;
  shutdown(): Promise<void>;
}

export type BootstrapResult =
  | { readonly status: 'started'; readonly host: StartedHost }
  | { readonly status: 'already-running' };

/**
 * Start the host, or refuse to.
 *
 * The order is load-bearing:
 *
 * 1. Take the single-instance lock first, so a second instance is a clean
 *    no-op that never even reads the environment.
 * 2. Take the API key out of `env` next, so it is gone before anything that
 *    could inherit or leak it exists — in particular before Electron creates
 *    the hidden renderer, which snapshots `process.env` at creation.
 * 3. Create the state root, then bind the port. A failure at either point is a
 *    refusal to start, not a degraded mode.
 *
 * @throws {StartupError} on any refusal to start.
 */
export async function bootstrapHost(runtime: HostRuntime): Promise<BootstrapResult> {
  const { env, logger } = runtime;

  if (!runtime.acquireInstanceLock()) {
    return { status: 'already-running' };
  }

  const apiKey = takeApiKey(env);
  const binding = readHttpBinding(env);

  const stateRoot = await ensureStateRoot(runtime.stateRoot);
  const configStore = await loadConfigStore({
    stateRoot,
    enumerateWindows: runtime.enumerateWindows,
  });

  // Not awaited: opening a session can take a moment (in production it waits
  // on the hidden renderer), and there is no reason to hold the HTTP bind
  // hostage to it. It's still "opened at startup" in the sense the spec
  // means -- kicked off here, before the first client can ever connect.
  const captureSessionCoordinator = startCaptureSessionCoordinator({
    initialTarget: configStore.get().targetWindow,
    onChange: configStore.onChange,
    openSession: runtime.openCaptureSession ?? NEVER_OPENS,
    logger,
  });

  const startServer = runtime.startHttpServer ?? defaultStartHttpServer;
  const server = await startServer({
    binding,
    routes: runtime.routes ?? createHostRoutes(),
    logger,
  });

  logger.info(`Screen Solver state root: ${stateRoot}`);
  logger.info(`Screen Solver listening on ${server.url} (bound ${server.host}:${server.port})`);

  return {
    status: 'started',
    host: {
      stateRoot,
      apiKey,
      binding: { host: server.host, port: server.port },
      server,
      configStore,
      captureSessionCoordinator,
      shutdown: async () => {
        await captureSessionCoordinator.stop();
        await server.close();
      },
    },
  };
}

/** True once the key has been taken — asserted by tests, and cheap insurance. */
export function apiKeyIsOutOfEnvironment(env: NodeJS.ProcessEnv): boolean {
  return !(API_KEY_ENV_VAR in env);
}
