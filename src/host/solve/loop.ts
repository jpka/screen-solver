import type { CaptureSessionCoordinator } from '../capture/session-coordinator.ts';
import { checkTargetStatus } from '../capture/target-status.ts';
import type { IsTargetMinimized } from '../capture/types.ts';
import type { ConfigStore } from '../config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity } from '../config/types.ts';
import { silentLogger, type Logger } from '../logger.ts';
import type { Provider } from '../provider/types.ts';
import type { EventBroadcaster } from './broadcaster.ts';
import type { SolveOutcome } from './types.ts';

/** Safe default when no `enumerateWindows` is injected: every target looks vanished -- the same "no windows" fallback `config/store.ts` and `bootstrap.ts` already use. */
const NO_WINDOWS: EnumerateWindows = () => Promise.resolve([]);
/** Safe default when no `isTargetMinimized` is injected: never minimized, so `enumerateWindows`/presence is the only guard that can ever fire. */
const NEVER_MINIMIZED: IsTargetMinimized = () => Promise.resolve(false);

export interface SolveLoopDeps {
  readonly configStore: ConfigStore;
  readonly captureSessionCoordinator: CaptureSessionCoordinator;
  readonly provider: Provider;
  readonly broadcaster: EventBroadcaster;
  readonly enumerateWindows?: EnumerateWindows;
  readonly isTargetMinimized?: IsTargetMinimized;
  /**
   * Fired once per solve attempt that actually reached the provider, with its
   * final outcome -- see `types.ts` for exactly what "reached the provider"
   * excludes. Left unset, outcomes are simply not observed (safe default for
   * callers that don't care, e.g. most tests).
   */
  readonly onOutcome?: (outcome: SolveOutcome) => void;
  readonly logger?: Logger;
}

export interface SolveLoop {
  /**
   * Always accepted, never busy-rejected (spec stories 11/26, #29's own
   * body): synchronously interrupts whatever solve is currently in flight,
   * then runs the pre-flight guards and the provider call for the new one
   * asynchronously. The `POST /solve` handler calls this and responds `202`
   * immediately after -- the abort below is synchronous with that response;
   * everything else in this file happens after the response has already gone
   * out.
   */
  trigger(): void;
  /** Resolves once the most recently triggered attempt has fully settled. Mainly for tests. */
  settled(): Promise<void>;
}

/**
 * Wires the capture pre-flight guards (#30) and the provider seam (#27)
 * together behind one `trigger()` call, broadcasting the result over SSE
 * (`broadcaster.ts`) and reporting the internal outcome (`types.ts`) for #31
 * to persist later.
 *
 * A pre-flight guard failure -- vanished/minimized target, or a black/
 * zero-size captured frame -- is a silent no-spend: no `broadcaster` call of
 * any kind, no `onOutcome`, no provider call (spec "Not-capturable / bad-
 * frame detection"; #29 acceptance criterion 4). `broadcaster.start()` is the
 * commit point: everything before it can end in total silence, everything
 * from it onward is a real attempted call that always ends in exactly one of
 * `done`/`interrupted`/`error`.
 *
 * Target changes are serialized through a plain `AbortController` swap rather
 * than a queue or a lock -- the same "supersede, don't queue" shape
 * `capture/session-coordinator.ts` uses for target changes, except here a
 * change always wins immediately rather than waiting for the previous
 * transition to finish first.
 */
export function startSolveLoop(deps: SolveLoopDeps): SolveLoop {
  const logger = deps.logger ?? silentLogger;
  const enumerateWindows = deps.enumerateWindows ?? NO_WINDOWS;
  const isTargetMinimized = deps.isTargetMinimized ?? NEVER_MINIMIZED;

  let controller: AbortController | null = null;
  let attempt: Promise<void> = Promise.resolve();

  function trigger(): void {
    const previous = controller;
    const next = new AbortController();
    controller = next;
    previous?.abort();

    const target = deps.configStore.get().targetWindow;
    attempt =
      target === null
        ? Promise.resolve()
        : runAttempt(target, next.signal).catch((error: unknown) => {
            logger.error(`solve loop: attempt failed unexpectedly: ${describeError(error)}`);
          });
  }

  async function runAttempt(target: TargetWindowIdentity, signal: AbortSignal): Promise<void> {
    const status = await checkTargetStatus(target, { enumerateWindows, isTargetMinimized });
    if (signal.aborted) return;
    if (status.presence === 'vanished' || status.minimized) return;

    const frame = await deps.captureSessionCoordinator.captureFrame();
    if (signal.aborted) return;
    if (frame === null || frame.quality === 'black-or-empty') return;

    // Committed: a provider call is genuinely attempted from here on, so the
    // wire and the outcome bus both go live for this attempt.
    deps.broadcaster.start();
    let text = '';

    for await (const event of deps.provider.solve(
      { mediaType: frame.mediaType, bytes: frame.bytes },
      { signal },
    )) {
      switch (event.type) {
        case 'delta':
          text += event.text;
          deps.broadcaster.delta(event.text);
          break;
        case 'done':
          deps.broadcaster.done(event.usage);
          deps.onOutcome?.({ type: 'done', text, usage: event.usage, stopReason: event.stopReason });
          return;
        case 'error':
          deps.broadcaster.error(event.kind);
          deps.onOutcome?.({ type: 'error', kind: event.kind, message: event.message, text });
          return;
      }
    }

    // The provider seam's own contract: aborting ends the iterable quietly,
    // no throw, no terminal event -- this is the only documented way the loop
    // reaches here without a `done`/`error` above.
    if (signal.aborted) {
      deps.onOutcome?.({ type: 'interrupted', text });
    } else {
      logger.error(
        'solve loop: the provider iterable ended without a terminal event and no abort was requested ' +
          '-- this violates the provider seam contract (see src/host/provider/types.ts)',
      );
    }
  }

  return {
    trigger,
    settled: () => attempt,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
