import type { CaptureSessionCoordinator } from '../capture/session-coordinator.ts';
import { checkTargetStatus } from '../capture/target-status.ts';
import type { IsTargetMinimized } from '../capture/types.ts';
import type { ConfigStore } from '../config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity } from '../config/types.ts';
import { silentLogger, type Logger } from '../logger.ts';
import type { Provider } from '../provider/types.ts';
import type { EventBroadcaster } from './broadcaster.ts';
import type { SolveOutcomeEvent } from './types.ts';

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
   * final outcome plus which window/model it belongs to -- see `types.ts`
   * for exactly what "reached the provider" excludes and why `target`/
   * `model` are wrapped around the outcome rather than folded into it. Left
   * unset, outcomes are simply not observed (safe default for callers that
   * don't care, e.g. most tests). May return a promise; `runAttempt` awaits
   * it, so `SolveLoop.settled()` only resolves once persistence (#31) has
   * actually finished writing, not just been kicked off.
   */
  readonly onOutcome?: (event: SolveOutcomeEvent) => void | Promise<void>;
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
   *
   * Returns `false`, having done nothing at all, once {@link stop} has been
   * called -- the one case where a trigger is genuinely refused rather than
   * accepted. `POST /solve` turns that into a `503` rather than a lying `202`.
   */
  trigger(): boolean;
  /** Resolves once the most recently triggered attempt has fully settled. Mainly for tests. */
  settled(): Promise<void>;
  /**
   * Shutdown: refuse further triggers, abort whatever attempt is in flight,
   * and resolve once *every* attempt still unwinding -- not just the most
   * recently triggered one -- has settled, including the `onOutcome` write
   * each makes on its way out (an aborted attempt that had reached the
   * provider still reports `interrupted`, so a partial answer is persisted
   * rather than lost).
   *
   * "Every attempt", plural, matters: a target change supersedes the previous
   * attempt by aborting it and starting a new one (`trigger()` below), but the
   * old attempt keeps running independently until *it* notices the abort and
   * unwinds -- that can still be in flight when a second, later change
   * supersedes the new one too. Tracking only the newest attempt (as an
   * earlier version of this method did) would let shutdown resolve the moment
   * the latest one settles, while an older superseded one is still mid-unwind
   * and hasn't called `onOutcome` yet -- silently losing that answer, the same
   * failure mode `recorder.ts`'s `drain()` exists for, but one `drain()` can't
   * catch on its own since it only awaits writes already enqueued.
   *
   * Three things this does that `settled()` alone can't. It *aborts* rather
   * than merely waiting, so a still-streaming provider ends promptly instead
   * of holding shutdown open for as long as the model feels like talking. It
   * waits for every attempt still outstanding, per the above. And it latches
   * the refusal, so a `POST /solve` arriving in the window between here and
   * the HTTP server actually closing can't start an attempt nothing is left
   * to wait for.
   *
   * Not a guarantee of promptness on its own: a provider that ignores its
   * `AbortSignal`, or a pre-flight seam that never resolves, can still stall
   * here. `bootstrap.ts` bounds the wait for that reason.
   */
  stop(): Promise<void>;
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
  let latest: Promise<void> = Promise.resolve();
  let stopped = false;
  // Every attempt currently unwinding, not just the latest -- a superseded
  // attempt (aborted by a later `trigger()`) stays in here until it actually
  // notices the abort and finishes, which is what lets `stop()` wait for it
  // too. Self-removing (see the `.finally()` below), so this is normally
  // empty or holds exactly one entry; more than one only while a just-
  // superseded attempt is still unwinding.
  const inFlight = new Set<Promise<void>>();

  function trigger(): boolean {
    if (stopped) return false;

    const previous = controller;
    const next = new AbortController();
    controller = next;
    previous?.abort();

    const target = deps.configStore.get().targetWindow;
    const run =
      target === null
        ? Promise.resolve()
        : runAttempt(target, next.signal).catch((error: unknown) => {
            logger.error(`solve loop: attempt failed unexpectedly: ${describeError(error)}`);
          });

    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
    latest = run;
    return true;
  }

  async function stop(): Promise<void> {
    stopped = true;
    controller?.abort();
    // `stopped` is latched above (synchronously, before any `await` in this
    // function yields control), so `trigger()` can add nothing further to
    // `inFlight` from this point on -- this snapshot is the complete set of
    // attempts shutdown will ever need to wait for.
    await Promise.all(inFlight);
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
          await deps.onOutcome?.({
            outcome: { type: 'done', text, usage: event.usage, stopReason: event.stopReason },
            target,
            model: deps.provider.model,
          });
          return;
        case 'error':
          deps.broadcaster.error(event.kind);
          await deps.onOutcome?.({
            outcome: { type: 'error', kind: event.kind, message: event.message, text },
            target,
            model: deps.provider.model,
          });
          return;
      }
    }

    // The provider seam's own contract: aborting ends the iterable quietly,
    // no throw, no terminal event -- this is the only documented way the loop
    // reaches here without a `done`/`error` above.
    if (signal.aborted) {
      await deps.onOutcome?.({ outcome: { type: 'interrupted', text }, target, model: deps.provider.model });
    } else {
      logger.error(
        'solve loop: the provider iterable ended without a terminal event and no abort was requested ' +
          '-- this violates the provider seam contract (see src/host/provider/types.ts)',
      );
    }
  }

  return {
    trigger,
    settled: () => latest,
    stop,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
