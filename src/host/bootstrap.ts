import { join } from 'node:path';
import { API_KEY_ENV_VAR, DEEPGRAM_API_KEY_ENV_VAR, takeApiKey, takeDeepgramApiKey } from './api-key.ts';
import { createDeepgramTranscriber } from './audio/deepgram.ts';
import type { RecordingCoordinator } from './audio/recording-coordinator.ts';
import type { OpenAudioCapture, Transcriber } from './audio/types.ts';
import { createTranscriptWindow } from './audio/window.ts';
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
import { createStaticRoutes } from './http/static.ts';
import { createAnswerLog } from './logs/answer-log.ts';
import { createSolveLogRecorder } from './logs/recorder.ts';
import { createScreenRecordingLog, RECORDINGS_DIR_NAME } from './logs/screen-recording-log.ts';
import { createTranscriptLog } from './logs/transcript-log.ts';
import { createUsageLog } from './logs/usage-log.ts';
import {
  createScreenRecordingCoordinator,
  type ScreenRecordingCoordinator,
} from './screen-recording/coordinator.ts';
import { createSegmentWriter } from './screen-recording/segment-writer.ts';
import type { OpenRecorder } from './screen-recording/types.ts';
import { settlesWithin } from './settles-within.ts';
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
  /**
   * The web client's static assets (#33) -- `src/main/index.ts` passes
   * `paths.ts`'s `webClientDir` (`static/client/`, gitignored by the build,
   * loaded as-is per `AGENTS.md`'s "Layout"). Left unset, no static routes
   * are added at all -- the same "safe default that just does less" shape as
   * `enumerateWindows`/`openCaptureSession`; existing tests that only care
   * about the JSON routes don't have to know this exists.
   */
  readonly clientStaticDir?: string;
  /**
   * Loopback audio capture. Electron supplies the real implementation
   * (`src/main/audio-capture.ts`); tests supply a fake that pushes canned
   * PCM. Left unset, the recording toggle reports `'unavailable'` -- the same
   * "safe default that just does less" shape as `openCaptureSession`.
   */
  readonly openAudioCapture?: OpenAudioCapture;
  /**
   * The transcription seam. Left unset, a real Deepgram transcriber is built
   * from `DEEPGRAM_API_KEY` if one was in the environment, and recording stays
   * `'unavailable'` if one wasn't. Tests inject a fake here instead of
   * touching the network -- the same shape as `provider`.
   */
  readonly transcriber?: Transcriber;
  /**
   * Opens a `MediaRecorder` over the live capture stream (#47) -- the *video*
   * recorder, distinct from `openAudioCapture` above. Electron supplies the
   * real implementation (`src/main/screen-recording.ts`); tests supply a fake.
   * Left unset, the screen-recording coordinator is still constructed and its
   * routes still exist, but it reports `unavailable` and never records -- the
   * same "safe default that just does less" shape as `openCaptureSession`.
   */
  readonly openRecorder?: OpenRecorder;
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
  /** The recording lifecycle: off until a client toggles it on, `'unavailable'` with no transcription key. */
  readonly recordingCoordinator: RecordingCoordinator;
  /** #47's continuous *screen* recorder, riding on top of that same capture session. */
  readonly screenRecordingCoordinator: ScreenRecordingCoordinator;
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
  // Taken in the same breath, and for the same reason: `env` has to be clean
  // of every key before Electron creates the hidden renderer, which snapshots
  // `process.env` at creation. Optional, unlike the Anthropic key -- see
  // `takeDeepgramApiKey`.
  const deepgramApiKey = takeDeepgramApiKey(env);
  const binding = readHttpBinding(env);

  // Built here rather than in `src/main`, unlike `enumerateWindows` and
  // `openCaptureSession`: the Anthropic provider (`provider/anthropic.ts`)
  // needs nothing Electron-specific, only the API key (just taken above) and
  // a fixed system prompt, both already available at this point in the
  // startup sequence.
  const provider = runtime.provider ?? createProvider({ apiKey, systemPrompt: DEFAULT_SYSTEM_PROMPT });

  // Same reasoning as `provider` above -- nothing Electron-specific is needed,
  // only the key just taken. `undefined` when no key was set, which is what
  // makes the recording toggle report `'unavailable'` instead of failing at
  // the moment someone presses it.
  const transcriber =
    runtime.transcriber ??
    (deepgramApiKey === null
      ? undefined
      : createDeepgramTranscriber({ apiKey: deepgramApiKey, logger }));

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

  // The transcript's durable half, alongside the two above; the in-memory
  // half is the bounded window `POST /solve/with-transcript` reads. Both are
  // created unconditionally -- an unused window costs nothing, and a
  // `transcript.jsonl` is only actually created on the first line written.
  const transcriptLog = createTranscriptLog({ stateRoot });
  const transcriptWindow = createTranscriptWindow();

  // #47's screen recorder. Built before the capture coordinator because that
  // coordinator's `onSessionChange` hook needs something to notify -- the
  // recorder follows the capture session, not the other way round. This is also
  // why it is constructed here rather than inside `createHostRoutes` the way
  // the audio recording coordinator is: by the time the routes exist, the
  // capture coordinator already needs it.
  const screenRecordingLog = createScreenRecordingLog({ stateRoot });
  const recordingsDir = join(stateRoot, RECORDINGS_DIR_NAME);
  const screenRecordingCoordinator = createScreenRecordingCoordinator({
    writer: createSegmentWriter({
      dir: recordingsDir,
      screenRecordingLog,
      // Routed back through the coordinator so a write failure lands in the
      // same `error` state a renderer failure does -- from the user's side
      // "the disk stopped accepting video" and "the recorder stopped producing
      // it" are the same event, and both must stop the recording rather than
      // let it appear to continue into nothing.
      onError: (reason) => screenRecordingCoordinator.fail(reason),
      logger,
    }),
    screenRecordingLog,
    openRecorder: runtime.openRecorder,
    settings: () => configStore.get().screenRecording,
    currentTarget: () => captureSessionCoordinator.currentTarget(),
    logger,
  });

  // Not awaited: opening a session can take a moment (in production it waits
  // on the hidden renderer), and there is no reason to hold the HTTP bind
  // hostage to it. It's still "opened at startup" in the sense the spec
  // means -- kicked off here, before the first client can ever connect.
  const captureSessionCoordinator = startCaptureSessionCoordinator({
    initialTarget: configStore.get().targetWindow,
    onChange: configStore.onChange,
    openSession: runtime.openCaptureSession ?? NEVER_OPENS,
    // #45: awaited (bounded) so the recorder flushes its last chunk against a
    // live stream rather than a stopped one. See `onSessionChange`'s own doc.
    onSessionChange: (target) => screenRecordingCoordinator.onCaptureSessionChange(target),
    logger,
  });

  // Repairs any segment left unclosed by an unclean exit, then applies
  // retention. Not awaited, for the same reason the capture session isn't:
  // reading the index and stat-ing files has nothing to do with whether the
  // HTTP surface can accept its first request.
  void screenRecordingCoordinator.reconcile().catch((error: unknown) => {
    logger.error(`screen recording: startup reconciliation failed: ${describeError(error)}`);
  });

  // `solveLoop` is `null` when `runtime.routes` was injected directly (tests
  // that bypass `createHostRoutes` entirely) -- shutdown then has no attempt
  // to await, the same "nothing to do" shape `solveLogRecorder.drain()` has
  // when nothing was ever recorded.
  const { routes, solveLoop, recordingCoordinator } = runtime.routes
    ? {
        routes: runtime.routes,
        solveLoop: null,
        // The full-bypass escape hatch gets a coordinator with nothing wired
        // into it, so `shutdown()` below has the same shape either way and
        // simply has nothing to close.
        recordingCoordinator: createHostRoutes({}).recordingCoordinator,
      }
    : createHostRoutes({
        configStore,
        captureSessionCoordinator,
        provider,
        enumerateWindows: runtime.enumerateWindows,
        isTargetMinimized: runtime.isTargetMinimized,
        onOutcome: (event) => solveLogRecorder.record(event),
        answerLog,
        transcriber,
        openAudioCapture: runtime.openAudioCapture,
        transcriptLog,
        transcriptWindow,
        screenRecordingCoordinator,
        screenRecordingLog,
        recordingsDir,
        logger,
      });

  // #33's web client, appended after the JSON/SSE routes above rather than
  // folded into `createHostRoutes` itself: static-asset serving has nothing
  // to do with the solve loop's dependency wiring, and `runtime.routes`
  // (the test-only full-bypass escape hatch) should stay a bypass of
  // *everything* server-side, static assets included -- not partially
  // reintroduced behind its back.
  const staticRoutes = runtime.clientStaticDir
    ? await createStaticRoutes({ dir: runtime.clientStaticDir })
    : [];

  const startServer = runtime.startHttpServer ?? defaultStartHttpServer;
  const server = await startServer({ binding, routes: [...routes, ...staticRoutes], logger });

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
      screenRecordingCoordinator,
      recordingCoordinator,
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
        //
        // Recording joins this same phase rather than getting a second one
        // after it, per `AGENTS.md`: "A future subsystem with the same shape
        // belongs in the same bounded phase, not in a second unbounded await
        // appended after it." Its order within the phase is load-bearing too --
        // `recordingCoordinator.stop()` sends Deepgram `CloseStream`, which is
        // what produces the *last* final of the session, so it has to run
        // before the `drain()` that waits for that final to reach disk. Each
        // transcription stream bounds its own close (`CLOSE_TIMEOUT_MS`,
        // 1.5s), which is what keeps two subsystems fitting inside one 5s
        // budget instead of the audio half starving the solve half.
        //
        // #47's screen recorder joins the same phase for the same reason, and
        // its ordering is load-bearing in the same way: `stop()` is what makes
        // the renderer flush the segment's final chunk, and `drain()` waits for
        // that chunk and its `closed` index line to reach disk. Both run
        // *before* `captureSessionCoordinator.stop()` below, because stopping
        // the capture session kills the very stream being flushed from -- the
        // same ordering the target-change path gets from `onSessionChange`,
        // applied to shutdown.
        //
        // Losing the video tail is survivable in a way losing the last answer
        // line isn't: the segment's bytes are already on disk, and the next
        // launch's `reconcile()` writes the `closed` line this gave up on.
        const drained = (async () => {
          await solveLoop?.stop();
          await recordingCoordinator.stop();
          await screenRecordingCoordinator.stop();
          await solveLogRecorder.drain();
          await recordingCoordinator.drain();
          await screenRecordingCoordinator.drain();
        })();
        if (!(await settlesWithin(drained, runtime.solveDrainTimeoutMs ?? SOLVE_DRAIN_TIMEOUT_MS))) {
          logger.warn(
            'Shutting down without waiting any longer for in-flight work to finish persisting. ' +
              'The last answers.jsonl / usage.jsonl / transcript.jsonl line may be missing or ' +
              'truncated, and any screen recording in progress will be closed out on the next ' +
              'launch instead.',
          );
        }

        await captureSessionCoordinator.stop();
        await server.close();
      },
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True once the key has been taken — asserted by tests, and cheap insurance. */
export function apiKeyIsOutOfEnvironment(env: NodeJS.ProcessEnv): boolean {
  return !(API_KEY_ENV_VAR in env);
}

/** The same assertion for the transcription key, which has the same must-not-reach-the-renderer rule. */
export function deepgramKeyIsOutOfEnvironment(env: NodeJS.ProcessEnv): boolean {
  return !(DEEPGRAM_API_KEY_ENV_VAR in env);
}
