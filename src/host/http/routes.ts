import type { TargetIntentTracker } from '../capture/intent.ts';
import type { IsTargetMinimized } from '../capture/types.ts';
import type { CaptureSessionCoordinator } from '../capture/session-coordinator.ts';
import type { ConfigStore } from '../config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity } from '../config/types.ts';
import type { AnswerLog } from '../logs/answer-log.ts';
import type { RecordingLog } from '../logs/recording-log.ts';
import type { Logger } from '../logger.ts';
import type { Provider } from '../provider/types.ts';
import type { RecordingCoordinator } from '../recording/coordinator.ts';
import { extensionFor } from '../recording/segment-writer.ts';
import { createSegmentFileRoute } from './segment-file.ts';
import { createEventBroadcaster } from '../solve/broadcaster.ts';
import { startSolveLoop, type SolveLoop } from '../solve/loop.ts';
import type { SolveOutcomeEvent } from '../solve/types.ts';
import { PayloadTooLargeError, readJsonBody, sendJson, type Route } from './router.ts';

export interface HostRoutesDeps {
  /**
   * #28's live config store -- `POST /solve` reads `.get().targetWindow`
   * synchronously to decide `400` vs `202`. #33 also builds `GET /config`,
   * `GET /windows`, and `POST /config/target` directly off this (the window
   * picker's entire HTTP surface), and wires `onChange` to the broadcaster's
   * `config{target}` SSE frame so a connected client learns about a target
   * change live.
   */
  readonly configStore?: ConfigStore;
  /** #30's capture session coordinator -- the frame-grab half of the pre-flight guard. */
  readonly captureSessionCoordinator?: CaptureSessionCoordinator;
  /** #27's provider seam -- the model call the solve loop actually makes once a frame clears both guards. */
  readonly provider?: Provider;
  /** #28's window enumeration, reused for the "still present" half of the pre-flight guard. Left unset, every target looks vanished. */
  readonly enumerateWindows?: EnumerateWindows;
  /** #30's minimized check, the other half of the pre-flight guard. Left unset, no target is ever treated as minimized. */
  readonly isTargetMinimized?: IsTargetMinimized;
  /** #32's deliberate-pause-vs-unexpected-loss intent flag. Left unset, a fresh always-`'active'` tracker is used -- every vanished target is treated as an unexpected loss. */
  readonly targetIntent?: TargetIntentTracker;
  /** #29's internal outcome bus -- see `src/host/solve/types.ts`. #31's `bootstrap.ts` wires this to a `SolveLogRecorder` that writes `answers.jsonl`/`usage.jsonl`. */
  readonly onOutcome?: (event: SolveOutcomeEvent) => void | Promise<void>;
  /** #31's `answers.jsonl` reader -- `GET /answers` serves its full backlog. Left unset, `GET /answers` answers `[]` (the same "nothing configured yet" default `enumerateWindows`/`isTargetMinimized` already use). */
  readonly answerLog?: AnswerLog;
  /** #45's recorder. Left unset, every `/recording*` route answers `503 not_ready`. */
  readonly recordingCoordinator?: RecordingCoordinator;
  /** #45's `recordings.jsonl` reader -- backs `GET /recordings` and resolves ids for the playback route. */
  readonly recordingLog?: RecordingLog;
  /** `<stateRoot>/recordings`. Required alongside `recordingLog` for the playback route to exist. */
  readonly recordingsDir?: string;
  readonly logger?: Logger;
}

export interface HostRoutes {
  readonly routes: readonly Route[];
  /**
   * The solve loop backing `POST /solve`, `null` when `configStore`/
   * `captureSessionCoordinator`/`provider` weren't all supplied (the same
   * condition that makes `POST /solve` answer `503` below). `bootstrap.ts`
   * calls `.stop()` on shutdown so the in-flight attempt's outcome -- and
   * #31's persistence of it -- finishes before the process exits, instead of
   * being silently abandoned mid-write, and so no *further* attempt can start
   * in the window before the server stops listening.
   */
  readonly solveLoop: SolveLoop | null;
}

/**
 * The routes the host serves.
 *
 * `configStore`, `captureSessionCoordinator`, and `provider` are all optional
 * so `createHostRoutes()` still works with no arguments (existing tests of
 * `/health` and generic routing rely on exactly that) -- but `POST /solve`
 * treats their absence as "the server itself isn't ready to accept a solve"
 * and answers `503`. In production this is unreachable: `bootstrapHost`
 * always supplies all three (a provider always exists once startup has
 * succeeded, since a missing API key already refused to start) -- the `503`
 * branch exists for routes constructed directly, the way a route-level test
 * does.
 */
export function createHostRoutes(deps: HostRoutesDeps = {}): HostRoutes {
  const broadcaster = createEventBroadcaster();
  const { configStore, captureSessionCoordinator, provider } = deps;

  const solveLoop =
    configStore !== undefined && captureSessionCoordinator !== undefined && provider !== undefined
      ? startSolveLoop({
          configStore,
          captureSessionCoordinator,
          provider,
          broadcaster,
          enumerateWindows: deps.enumerateWindows,
          isTargetMinimized: deps.isTargetMinimized,
          targetIntent: deps.targetIntent,
          onOutcome: deps.onOutcome,
          logger: deps.logger,
        })
      : null;

  // #33: mirrors every target-window change onto the SSE wire, so a
  // connected client reacts live (a fresh pick, or #32's own mid-run
  // fallback to `null`) without a reload. Subscribed for the process's
  // whole lifetime, the same as `startCaptureSessionCoordinator`'s own
  // `configStore.onChange` subscription in `bootstrap.ts` -- there is no
  // teardown path for `createHostRoutes` itself to hook a matching
  // `unsubscribe` into.
  if (configStore !== undefined) {
    configStore.onChange((event) => {
      broadcaster.config(event.target);
    });
  }

  // #45: same shape and same lifetime as the target-change mirror above --
  // every recorder state change (and the once-a-second byte tick while
  // recording) becomes a `recording` SSE frame.
  const { recordingCoordinator } = deps;
  if (recordingCoordinator !== undefined) {
    recordingCoordinator.onStateChange((snapshot) => {
      broadcaster.recording(snapshot);
    });
  }

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/health',
      handle: ({ res }) => {
        sendJson(res, 200, { status: 'ok', service: 'screen-solver' });
      },
    },
    {
      method: 'POST',
      path: '/solve',
      handle: ({ res }) => {
        if (solveLoop === null || configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }

        const target = configStore.get().targetWindow;
        if (target === null) {
          sendJson(res, 400, { error: 'no_target_configured' });
          return;
        }

        // Synchronous with the 202 below: whatever solve was in flight is
        // aborted right here. The pre-flight guards and the provider call for
        // this new solve run asynchronously, after the response has already
        // gone out (#29's own body: "This abort is synchronous with the 202").
        //
        // The one way this comes back refused is shutdown having already begun
        // (`SolveLoop.stop()`): the server is still listening for the moment it
        // takes to close, but nothing is left to run or persist a new attempt,
        // so say so rather than accepting work that will silently evaporate.
        if (!solveLoop.trigger()) {
          sendJson(res, 503, { error: 'shutting_down' });
          return;
        }
        sendJson(res, 202, { status: 'accepted' });
      },
    },
    {
      method: 'GET',
      path: '/events',
      handle: ({ req, res }) => {
        const unsubscribe = broadcaster.subscribe(res);
        req.on('close', unsubscribe);
      },
    },
    {
      method: 'GET',
      path: '/answers',
      handle: async ({ res }) => {
        // Independent of the live `/events` connection (spec): reads
        // `answers.jsonl` fresh on every request, no in-memory cache to keep
        // in sync -- `deps.answerLog` itself already has this property
        // (`logs/jsonl.ts`'s `readAll()`), so there's nothing extra to do
        // here beyond serving whatever it hands back.
        const entries = deps.answerLog === undefined ? [] : await deps.answerLog.readAll();
        sendJson(res, 200, entries);
      },
    },
    {
      // #33: the one thing a client can't learn from `GET /events` alone --
      // what the target is *right now*, on first load, before any `config`
      // frame has ever been broadcast. Kept deliberately narrow (just the
      // field the picker cares about) rather than exposing the whole
      // `ScreenSolverConfig`, since `provider` is reserved and unused by any
      // ticket through #33. `revision` is `broadcaster.ts`'s own counter --
      // see its doc comment on `SseEvent`'s `config` variant -- so a client
      // can tell whether this snapshot is newer or older than a `config` SSE
      // frame it may have already received, rather than just trusting
      // whichever happened to arrive first over its own separate connection.
      method: 'GET',
      path: '/config',
      handle: ({ res }) => {
        if (configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }
        sendJson(res, 200, {
          targetWindow: configStore.get().targetWindow,
          revision: broadcaster.currentConfigRevision(),
        });
      },
    },
    {
      // #33: the window picker's list -- same enumeration `POST /solve`'s
      // pre-flight guard already reaches through `configStore`, just exposed
      // directly rather than only consumed internally.
      method: 'GET',
      path: '/windows',
      handle: async ({ res }) => {
        if (configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }
        const windows = await configStore.listWindows();
        sendJson(res, 200, windows);
      },
    },
    {
      // #33: the picker's "commit a choice" action. A JSON body of
      // `{processName, title}` sets the target; an explicit `null` body (or
      // no body at all -- `readJsonBody`'s own empty-body default) clears it.
      // A malformed body (bad shape or bad JSON) is `400`, same status
      // `router.ts`'s own bad-URL guard already uses for "this request
      // doesn't make sense"; a body over `readJsonBody`'s own byte cap is
      // `413`.
      method: 'POST',
      path: '/config/target',
      handle: async ({ req, res }) => {
        if (configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            sendJson(res, 413, { error: 'payload_too_large' });
          } else {
            sendJson(res, 400, { error: 'bad_request' });
          }
          return;
        }

        const target = parseTargetBody(body);
        if (target === INVALID_TARGET) {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }

        await configStore.setTargetWindow(target);
        // `setTargetWindow` above has already driven the `onChange`
        // subscription (below) synchronously, so `currentConfigRevision()`
        // here is exactly the revision the resulting `config` SSE frame
        // carried -- this response is just as fresh as that frame.
        sendJson(res, 200, { targetWindow: target, revision: broadcaster.currentConfigRevision() });
      },
    },
    {
      // #45: the recorder's state on first load, before any `recording` SSE
      // frame has arrived. Exactly the gap `GET /config` fills for the target
      // -- a client that only learned the state from SSE would render "not
      // recording" until the next frame, which for this particular feature is
      // the one wrong thing it could say.
      method: 'GET',
      path: '/recording',
      handle: ({ res }) => {
        sendJson(res, 200, recordingCoordinator?.snapshot() ?? broadcaster.currentRecording());
      },
    },
    {
      method: 'POST',
      path: '/recording/start',
      handle: async ({ res }) => {
        if (recordingCoordinator === undefined || configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }
        // There is nothing to record without a capture stream, and starting
        // anyway would sit in `starting` until the renderer's handshake timed
        // out -- a slow, confusing way to say something the server already
        // knows.
        if (configStore.get().targetWindow === null) {
          sendJson(res, 409, { error: 'no_capture_session' });
          return;
        }
        sendJson(res, 200, await recordingCoordinator.start());
      },
    },
    {
      method: 'POST',
      path: '/recording/stop',
      handle: async ({ res }) => {
        if (recordingCoordinator === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }
        await recordingCoordinator.stop();
        sendJson(res, 200, recordingCoordinator.snapshot());
      },
    },
    {
      method: 'GET',
      path: '/recordings',
      handle: async ({ res }) => {
        // Read fresh per request, like `GET /answers`: a segment that rolled a
        // moment ago has to show up without any cache to invalidate.
        const segments = deps.recordingLog === undefined ? [] : await deps.recordingLog.readIndex();
        sendJson(res, 200, segments);
      },
    },
    {
      method: 'GET',
      path: '/recording/settings',
      handle: ({ res }) => {
        if (configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }
        sendJson(res, 200, configStore.get().recording);
      },
    },
    {
      method: 'POST',
      path: '/recording/settings',
      handle: async ({ req, res }) => {
        if (configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            sendJson(res, 413, { error: 'payload_too_large' });
          } else {
            sendJson(res, 400, { error: 'bad_request' });
          }
          return;
        }

        const patch = parseRecordingSettingsBody(body);
        if (patch === INVALID_SETTINGS) {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }

        // The store clamps and persists; the response is whatever it actually
        // stored, not the patch, so a client that sent an out-of-range value
        // sees the clamped truth rather than believing its own request.
        sendJson(res, 200, await configStore.setRecordingSettings(patch));
      },
    },
  ];

  // Only registered when both halves exist -- the route cannot serve anything
  // useful with an index but no directory to read from, and a route that always
  // 503s is worse than a 404 from the router's own miss.
  if (deps.recordingLog !== undefined && deps.recordingsDir !== undefined) {
    routes.push(
      createSegmentFileRoute({
        recordingLog: deps.recordingLog,
        dir: deps.recordingsDir,
        logger: deps.logger,
      }),
    );
  }

  return { routes, solveLoop };
}

const INVALID_SETTINGS = Symbol('invalid-recording-settings');

/**
 * A partial {@link RecordingSettings} patch, or {@link INVALID_SETTINGS}.
 *
 * Unknown keys are ignored rather than rejected, and an absent key means "leave
 * it alone" -- the client only ever moves one control at a time. A key that is
 * *present* with the wrong type is a genuine `400`, though: silently discarding
 * it would leave the user staring at a control that snapped back with no
 * explanation.
 */
function parseRecordingSettingsBody(
  body: unknown,
): Partial<{ enabled: boolean; segmentSeconds: number; retentionBytes: number; retentionDays: number }> | typeof INVALID_SETTINGS {
  if (body === null) return {};
  if (typeof body !== 'object') return INVALID_SETTINGS;

  const candidate = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if ('enabled' in candidate) {
    if (typeof candidate.enabled !== 'boolean') return INVALID_SETTINGS;
    patch.enabled = candidate.enabled;
  }
  for (const key of ['segmentSeconds', 'retentionBytes', 'retentionDays'] as const) {
    if (!(key in candidate)) continue;
    if (typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key])) {
      return INVALID_SETTINGS;
    }
    patch[key] = candidate[key];
  }

  return patch;
}

const INVALID_TARGET = Symbol('invalid-target');

/** `null` (clear), a well-formed `{processName, title}` (set), or {@link INVALID_TARGET}. */
function parseTargetBody(body: unknown): TargetWindowIdentity | null | typeof INVALID_TARGET {
  if (body === null) return null;
  if (
    typeof body === 'object' &&
    typeof (body as Record<string, unknown>).processName === 'string' &&
    typeof (body as Record<string, unknown>).title === 'string'
  ) {
    return body as TargetWindowIdentity;
  }
  return INVALID_TARGET;
}
