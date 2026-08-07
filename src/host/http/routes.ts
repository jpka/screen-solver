import type { TargetIntentTracker } from '../capture/intent.ts';
import type { IsTargetMinimized } from '../capture/types.ts';
import type { CaptureSessionCoordinator } from '../capture/session-coordinator.ts';
import type { ConfigStore } from '../config/store.ts';
import type { EnumerateWindows } from '../config/types.ts';
import type { AnswerLog } from '../logs/answer-log.ts';
import type { Logger } from '../logger.ts';
import type { Provider } from '../provider/types.ts';
import { createEventBroadcaster } from '../solve/broadcaster.ts';
import { startSolveLoop, type SolveLoop } from '../solve/loop.ts';
import type { SolveOutcomeEvent } from '../solve/types.ts';
import { sendJson, type Route } from './router.ts';

export interface HostRoutesDeps {
  /** #28's live config store -- `POST /solve` reads `.get().targetWindow` synchronously to decide `400` vs `202`. */
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
  ];

  return { routes, solveLoop };
}
