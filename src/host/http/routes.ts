import type { IsTargetMinimized } from '../capture/types.ts';
import type { CaptureSessionCoordinator } from '../capture/session-coordinator.ts';
import type { ConfigStore } from '../config/store.ts';
import type { EnumerateWindows } from '../config/types.ts';
import type { Logger } from '../logger.ts';
import type { Provider } from '../provider/types.ts';
import { createEventBroadcaster } from '../solve/broadcaster.ts';
import { startSolveLoop } from '../solve/loop.ts';
import type { SolveOutcome } from '../solve/types.ts';
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
  /** #29's internal outcome bus -- see `src/host/solve/types.ts`. #31 is the eventual consumer. */
  readonly onOutcome?: (outcome: SolveOutcome) => void;
  readonly logger?: Logger;
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
export function createHostRoutes(deps: HostRoutesDeps = {}): Route[] {
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
          onOutcome: deps.onOutcome,
          logger: deps.logger,
        })
      : null;

  return [
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
        solveLoop.trigger();
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
  ];
}
