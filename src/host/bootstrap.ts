import { API_KEY_ENV_VAR, takeApiKey } from './api-key.ts';
import { readHttpBinding, type HttpBinding } from './binding.ts';
import {
  startCaptureSessionCoordinator,
  type CaptureSessionCoordinator,
} from './capture/session-coordinator.ts';
import type { IsTargetMinimized, OpenCaptureSession } from './capture/types.ts';
import { loadConfigStore, type ConfigStore } from './config/store.ts';
import type { EnumerateWindows } from './config/types.ts';
import { createHostRoutes } from './http/routes.ts';
import type { Route } from './http/router.ts';
import { createAnswerLog } from './logs/answer-log.ts';
import { createSolveLogRecorder } from './logs/recorder.ts';
import { createUsageLog } from './logs/usage-log.ts';
import {
  startHttpServer as defaultStartHttpServer,
  type ListeningHttpServer,
  type StartHttpServer,
} from './http/server.ts';
import type { Logger } from './logger.ts';
import { createProvider } from './provider/anthropic.ts';
import { DEFAULT_SYSTEM_PROMPT } from './provider/system-prompt.ts';
import type { Provider } from './provider/types.ts';
import type { Secret } from './secret.ts';
import { ensureStateRoot } from './state-root.ts';

/** No opener was injected. Nothing ever opens, which is a safe default for tests that don't care about capture. */
const NEVER_OPENS: OpenCaptureSession = () => Promise.reject(new Error('No capture session opener configured.'));

/**
 * How long `shutdown()` will wait for the in-flight solve to end and its JSONL
 * lines to land before giving up and tearing down anyway.
 *
 * There has to be *some* bound. Aborting the attempt (`SolveLoop.stop()`) is
 * what normally ends it promptly, but abort is cooperative: a provider stream
 * that ignores its signal, a window-enumeration call that never returns, or a
 * hung `fs.appendFile` would otherwise leave the process alive indefinitely
 * after the user asked it to quit. Losing the last answer's line is the lesser
 * failure of the two, and it's logged when it happens.
 */
const SOLVE_DRAIN_TIMEOUT_MS = 5_000;

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
  /**
   * Whether the target window is minimized (#30's `IsIconic`-equivalent
   * check) — the other half of `POST /solve`'s pre-flight guard (#29),
   * alongside `enumerateWindows`. Electron supplies the real implementation
   * (`src/main/minimized-check.ts`); tests supply a fake. Left unset, no
   * target is ever treated as minimized — the same "safe default" shape as
   * `enumerateWindows` and `openCaptureSession`.
   */
  readonly isTargetMinimized?: IsTargetMinimized;
  /**
   * The provider seam (#27) the solve loop (#29) calls to turn a captured
   * frame into an answer. Left unset, a real Anthropic provider is
   * constructed from the API key just taken out of `env` and a fixed system
   * prompt (`src/host/provider/system-prompt.ts`); tests inject a fake here
   * instead of touching the network.
   */
  readonly provider?: Provider;
  /**
   * Overrides {@link SOLVE_DRAIN_TIMEOUT_MS}. Injected by tests that need to
   * assert the give-up path without sitting out the real timeout; production
   * never sets it.
   */
  readonly solveDrainTimeoutMs?: number;
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

  // Built here rather than in `src/main`, unlike `enumerateWindows` and
  // `openCaptureSession`: the Anthropic provider (`provider/anthropic.ts`)
  // needs nothing Electron-specific, only the API key (just taken above) and
  // a fixed system prompt, both already available at this point in the
  // startup sequence.
  const provider = runtime.provider ?? createProvider({ apiKey, systemPrompt: DEFAULT_SYSTEM_PROMPT });

  const stateRoot = await ensureStateRoot(runtime.stateRoot);
  const configStore = await loadConfigStore({
    stateRoot,
    enumerateWindows: runtime.enumerateWindows,
  });

  // #31's durable memory: `answers.jsonl` / `usage.jsonl` under the same
  // state root. `answerLog` is also handed to `createHostRoutes` directly
  // (`GET /answers` reads it fresh on every request); `usageLog` only ever
  // goes through the recorder below -- nothing else needs to read it back.
  const answerLog = createAnswerLog({ stateRoot });
  const usageLog = createUsageLog({ stateRoot });
  const solveLogRecorder = createSolveLogRecorder({ answerLog, usageLog, logger });

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

  // `solveLoop` is `null` when `runtime.routes` was injected directly (tests
  // that bypass `createHostRoutes` entirely) -- shutdown then has no attempt
  // to await, the same "nothing to do" shape `solveLogRecorder.drain()` has
  // when nothing was ever recorded.
  const { routes, solveLoop } = runtime.routes
    ? { routes: runtime.routes, solveLoop: null }
    : createHostRoutes({
        configStore,
        captureSessionCoordinator,
        provider,
        enumerateWindows: runtime.enumerateWindows,
        isTargetMinimized: runtime.isTargetMinimized,
        onOutcome: (event) => solveLogRecorder.record(event),
        answerLog,
        logger,
      });

  const startServer = runtime.startHttpServer ?? defaultStartHttpServer;
  const server = await startServer({ binding, routes, logger });

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
        // Let whatever solve attempt is currently in flight reach a terminal
        // outcome -- and #31's persistence of it -- before tearing anything
        // down. `solveLoop.stop()` aborts that attempt and doesn't resolve
        // until `onOutcome` (which writes the JSONL lines) has already been
        // awaited (`solve/loop.ts`); it also latches the loop closed, so a
        // `POST /solve` landing in the gap before `server.close()` below is
        // refused rather than starting work nothing here is left to wait for.
        // `solveLogRecorder.drain()` is the belt to that suspenders: it also
        // waits out a *superseded* attempt's write still queued behind it,
        // which `stop()` alone wouldn't catch since the loop only tracks the
        // most recently triggered attempt.
        //
        // Bounded as a whole, per `SOLVE_DRAIN_TIMEOUT_MS`: neither the abort
        // nor the disk write is something this process can force to complete,
        // and shutdown has to end regardless.
        const drained = (async () => {
          await solveLoop?.stop();
          await solveLogRecorder.drain();
        })();
        if (!(await settlesWithin(drained, runtime.solveDrainTimeoutMs ?? SOLVE_DRAIN_TIMEOUT_MS))) {
          logger.warn(
            'Shutting down without waiting any longer for the in-flight solve to finish persisting. ' +
              'Its answers.jsonl / usage.jsonl line may be missing or truncated.',
          );
        }

        await captureSessionCoordinator.stop();
        await server.close();
      },
    },
  };
}

/**
 * Resolves `true` once `work` settles, or `false` if `timeoutMs` elapses
 * first. The timer is cleared on the happy path, so a shutdown that drains
 * immediately doesn't hold the event loop open for the rest of the timeout.
 *
 * `work` is caught rather than propagated: everything it awaits already
 * handles its own failures (`trigger()` catches the attempt, `record()`
 * catches each chained write), and a rejection arriving *after* a timeout has
 * already moved shutdown on would otherwise surface as an unhandled rejection
 * with nobody left to receive it.
 */
function settlesWithin(work: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void work
      .catch(() => {})
      .then(() => {
        clearTimeout(timer);
        resolve(true);
      });
  });
}

/** True once the key has been taken — asserted by tests, and cheap insurance. */
export function apiKeyIsOutOfEnvironment(env: NodeJS.ProcessEnv): boolean {
  return !(API_KEY_ENV_VAR in env);
}
