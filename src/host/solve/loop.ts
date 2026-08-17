import type { TranscriptWindow } from '../audio/window.ts';
import type { CaptureSessionCoordinator } from '../capture/session-coordinator.ts';
import { checkTargetStatus } from '../capture/target-status.ts';
import { createTargetIntentTracker, type TargetIntentTracker } from '../capture/intent.ts';
import type { IsTargetMinimized } from '../capture/types.ts';
import type { ConfigStore } from '../config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity } from '../config/types.ts';
import type { PreloadContextReader } from '../context/preload-context.ts';
import { silentLogger, type Logger } from '../logger.ts';
import type { Provider, SolveImage } from '../provider/types.ts';
import type { EventBroadcaster } from './broadcaster.ts';
import { createStatusTracker, type StatusTracker } from './status.ts';
import type { SolveOutcome, SolveOutcomeEvent } from './types.ts';

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
  /**
   * The "deliberate pause vs unexpected loss" intent flag (#32; see
   * `capture/intent.ts`). Left unset, a fresh tracker is created that always
   * reads `'active'` -- every vanished target is treated as an unexpected
   * loss, which is today's only reachable behavior since no caller yet wires
   * a pause action to it.
   */
  readonly targetIntent?: TargetIntentTracker;
  /**
   * The bounded recent-speech buffer the two transcript-carrying modes read.
   * Left unset, either mode can still be triggered but never finds anything
   * to send -- a `screen-with-transcript` solve stays image-only, and a
   * `transcript-only` one has nothing at all to ask about and bails out
   * silently. The same "safe default that just does less" every other optional
   * dep here uses.
   */
  readonly transcriptWindow?: TranscriptWindow;
  /**
   * Reads whatever `config.json`'s `contextPath` points at (`context/
   * preload-context.ts`), fresh, for every attempt that reaches the
   * provider -- every mode, not just the screen ones, since preloaded
   * context is background that applies regardless of how the question
   * arrived. Left unset, no attempt ever carries any -- the same "safe
   * default that just does less" shape as `transcriptWindow`.
   */
  readonly preloadContextReader?: PreloadContextReader;
  readonly logger?: Logger;
}

/**
 * What a triggered solve is made of -- one mode per client button, and per
 * route in `http/routes.ts`.
 *
 * A union rather than the pair of booleans it would otherwise have become
 * ("include the transcript" plus "skip the screenshot"), because two of the
 * four combinations are not things this app does: a solve with neither a
 * screen nor speech has no question in it, and there is no button for one.
 * Making the mode a closed set also means `runAttempt` branches once, on a
 * value it can exhaust, rather than twice on flags that could disagree.
 */
export type SolveMode =
  /** `POST /solve`: the screenshot alone, byte-identical to what it always was. */
  | 'screen'
  /** `POST /solve/with-transcript`: the screenshot, plus recent speech as a hint about it. */
  | 'screen-with-transcript'
  /**
   * `POST /solve/transcript-only`: recent speech and no screenshot at all --
   * the question was asked out loud. No target window is needed, and none of
   * the capture pre-flight guards apply, since nothing is captured.
   */
  | 'transcript-only';

export interface TriggerOptions {
  /** Defaults to `'screen'`, which is what keeps `POST /solve` unchanged -- see `SolveLoop.trigger`. */
  readonly mode?: SolveMode;
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
   *
   * `options` defaults to `mode: 'screen'`, so the existing `POST /solve` call
   * site is unchanged in behavior and on the wire. The other two modes belong
   * to the two later routes -- see {@link SolveMode}.
   */
  trigger(options?: TriggerOptions): boolean;
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
  const targetIntent = deps.targetIntent ?? createTargetIntentTracker();
  // One tracker for the life of this loop -- the standing status pill (#32)
  // is app-wide, not per-attempt, so it has to survive across `runAttempt`
  // calls the same way `broadcaster`'s own in-flight text does.
  const statusTracker: StatusTracker = createStatusTracker();

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

  function trigger(options: TriggerOptions = {}): boolean {
    if (stopped) return false;

    const mode = options.mode ?? 'screen';

    const previous = controller;
    const next = new AbortController();
    controller = next;
    previous?.abort();

    // Rendered here, synchronously with the trigger, rather than inside
    // `runAttempt` after the pre-flight guards have awaited: the transcript is
    // meant to be "what was being said when the button was pressed", and the
    // guards can take long enough (a window enumeration, a minimized check, a
    // frame grab) that re-reading the window afterwards would fold in
    // sentences spoken after the user asked.
    const transcript = mode === 'screen' ? null : (deps.transcriptWindow?.render() ?? null);

    // A spoken-only solve is deliberately blind to the configured target: no
    // frame is grabbed, so a vanished, minimized, or entirely unconfigured
    // window is irrelevant to it. `null` is what tells `runAttempt` there is
    // no screen in this attempt at all, and it is what lands in the logs --
    // see `SolveOutcomeEvent.target`.
    const target = mode === 'transcript-only' ? null : deps.configStore.get().targetWindow;

    // A screen mode with nothing configured to watch has no attempt to make --
    // `POST /solve` has already answered `400 no_target_configured`, and this
    // is the loop's own matching no-op. Note this is *not* the same shape as
    // the spoken-only mode, which reaches `runAttempt` with a deliberately
    // null target because it never wanted a window in the first place.
    const nothingToSolve = mode !== 'transcript-only' && target === null;
    const run = nothingToSolve
      ? Promise.resolve()
      : runAttempt(target, next.signal, transcript).catch((error: unknown) => {
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

  /**
   * One attempt, for all three modes.
   *
   * `target === null` means the spoken-only mode: there is no screen in this
   * attempt, so the whole pre-flight block below is skipped rather than
   * guarded field by field, and the provider is handed a `null` image. Every
   * mode shares one commit point (`broadcaster.start()`) and one outcome
   * report, which is what keeps "exactly one of done/interrupted/error per
   * attempted call" true no matter which button was pressed.
   */
  async function runAttempt(
    target: TargetWindowIdentity | null,
    signal: AbortSignal,
    transcript: string | null,
  ): Promise<void> {
    // Only tagged when a transcript was actually sent. A "Solve with
    // transcript" pressed during silence is, on the wire and in the logs,
    // exactly an ordinary solve -- which is the honest record of what happened.
    const withTranscript = transcript === null ? {} : { withTranscript: true as const };

    if (target === null) {
      // Spoken-only, and nothing has been said: there is no question in this
      // request, so it is the same silent no-spend a failed capture guard is.
      // `POST /solve/transcript-only` normally refuses this before it gets
      // here (`400 no_transcript`) -- this is the belt to that suspenders, and
      // it covers a window that emptied between the route's check and here.
      if (transcript === null) return;

      await callProvider(null, target, transcript, signal, withTranscript);
      return;
    }

    let status = await checkTargetStatus(target, { enumerateWindows, isTargetMinimized });
    if (signal.aborted) return;

    if (status.presence === 'vanished') {
      if (targetIntent.current() === 'paused') {
        // Deliberate pause (spec: "Three-way split on an app-tracked intent
        // flag: deliberate pause → ignored..."): a vanished target is
        // expected right now and is ignored outright -- same silent no-spend
        // as any other pre-flight guard failure, no re-resolution, no
        // fallback.
        return;
      }

      // Unexpected loss: exactly one silent re-resolution attempt before
      // concluding the target is genuinely gone (spec: "...unexpected loss →
      // one silent re-resolution, then fallback to the picker"). Re-running
      // the full check (not just presence) means a target that's back also
      // has its minimized-ness re-read, rather than trusting a stale `false`
      // default from the first, vanished-branch check.
      status = await checkTargetStatus(target, { enumerateWindows, isTargetMinimized });
      if (signal.aborted) return;

      if (status.presence === 'vanished') {
        // Still gone: fall back to the picker by clearing the configured
        // target. `ConfigStore.setTargetWindow` (#28) both persists the
        // clear and broadcasts `config{target: null}` to every connected
        // client -- #33's eventual picker reacts to that; #30's capture
        // session coordinator reacts to the very same change by tearing down
        // the now-pointless session. Nothing further to do here, and no
        // provider call was ever spent (spec table: "N/A").
        await deps.configStore.setTargetWindow(null).catch((error: unknown) => {
          logger.error(
            `solve loop: failed to clear the vanished target ${target.processName} / "${target.title}": ${describeError(error)}`,
          );
        });
        return;
      }
      // Re-resolved on the retry: fall through and treat it exactly as if
      // the first check had already found it present.
    }
    if (status.minimized) return;

    const frame = await deps.captureSessionCoordinator.captureFrame();
    if (signal.aborted) return;
    if (frame === null || frame.quality === 'black-or-empty') return;

    await callProvider(
      { mediaType: frame.mediaType, bytes: frame.bytes },
      target,
      transcript,
      signal,
      withTranscript,
    );
  }

  /**
   * The committed half of an attempt: everything from the provider call
   * onwards, shared by the screen modes and the spoken-only one.
   *
   * Extracted rather than duplicated per mode precisely because this is the
   * part with the invariants -- one `start` on the wire, exactly one terminal
   * outcome, one status transition, one `onOutcome` -- and a second copy of it
   * is where those would drift. `image` is `null` only for the spoken-only
   * mode, which is also the only case `target` is `null`; the two travel
   * together but stay separate parameters, since the provider needs the image
   * and the logs need the target.
   */
  async function callProvider(
    image: SolveImage | null,
    target: TargetWindowIdentity | null,
    transcript: string | null,
    signal: AbortSignal,
    withTranscript: { readonly withTranscript?: true },
  ): Promise<void> {
    // Read fresh for every attempt that reaches here, regardless of mode --
    // there is no "instant of the trigger" concern for this the way there is
    // for the transcript window (`trigger()`'s own comment above): the file
    // it reads is not a record of something said just now, so reading it a
    // few pre-flight guards later changes nothing about what it means.
    const preloadContext = (await deps.preloadContextReader?.read()) ?? null;
    // Re-checked here, and only here between entering this function and the
    // commit point below: this is the one `await` `callProvider` does before
    // `broadcaster.start()`, so it is the one place a later `trigger()` can
    // have aborted `signal` out from under an attempt that hasn't committed
    // yet. Skipping this check would let `broadcaster.start()` fire for an
    // attempt already known to be superseded -- the provider then ends
    // quietly for the aborted signal with no `delta`/`done`/`error` of its
    // own, and the `interrupted` branch below never calls `broadcaster.done()`
    // / `.error()` to close out the `start` this would have just broadcast,
    // leaving a connected client stuck showing "in flight" until some later,
    // unrelated attempt happens to start again.
    if (signal.aborted) return;
    const withPreloadContext: { readonly withPreloadContext?: true } =
      preloadContext === null ? {} : { withPreloadContext: true };

    // Committed: a provider call is genuinely attempted from here on, so the
    // wire and the outcome bus both go live for this attempt.
    deps.broadcaster.start();
    let text = '';

    for await (const event of deps.provider.solve(image, {
      signal,
      // Both stay absent rather than `undefined`-valued when there is
      // nothing to send, so a plain solve builds a request byte-identical to
      // the one it built before either option existed.
      ...(transcript === null ? {} : { transcript }),
      ...(preloadContext === null ? {} : { preloadContext }),
    })) {
      switch (event.type) {
        case 'delta':
          text += event.text;
          deps.broadcaster.delta(event.text);
          break;
        case 'done': {
          deps.broadcaster.done(event.usage);
          const outcome: SolveOutcome = { type: 'done', text, usage: event.usage, stopReason: event.stopReason };
          applyStatusTransition(outcome);
          await deps.onOutcome?.({
            outcome,
            target,
            model: deps.provider.model,
            ...withTranscript,
            ...withPreloadContext,
          });
          return;
        }
        case 'error': {
          deps.broadcaster.error(event.kind);
          const outcome: SolveOutcome = { type: 'error', kind: event.kind, message: event.message, text };
          applyStatusTransition(outcome);
          await deps.onOutcome?.({
            outcome,
            target,
            model: deps.provider.model,
            ...withTranscript,
            ...withPreloadContext,
          });
          return;
        }
      }
    }

    // The provider seam's own contract: aborting ends the iterable quietly,
    // no throw, no terminal event -- this is the only documented way the loop
    // reaches here without a `done`/`error` above.
    if (signal.aborted) {
      const outcome: SolveOutcome = { type: 'interrupted', text };
      // `interrupted` never moves the status ladder (`status.ts`'s own
      // rules) -- called anyway so the "one place decides" property holds
      // even though this call is always a no-op today.
      applyStatusTransition(outcome);
      await deps.onOutcome?.({
        outcome,
        target,
        model: deps.provider.model,
        ...withTranscript,
        ...withPreloadContext,
      });
    } else {
      logger.error(
        'solve loop: the provider iterable ended without a terminal event and no abort was requested ' +
          '-- this violates the provider seam contract (see src/host/provider/types.ts)',
      );
    }
  }

  /**
   * Folds one outcome into the standing status pill (#32), broadcasting
   * `status` and printing the one required console line only when the level
   * actually changed -- `statusTracker.onOutcome` already does the
   * "did anything change" filtering, so this is purely "what to do once it
   * has".
   *
   * The console line is the acceptance criterion's own wording: "A sticky
   * status transition prints one line to the host's console" -- printed on
   * the way *into* `sticky`. The matching recovery line (back to `silent`,
   * whether from `sticky` or `auto-recovering`) isn't required by that
   * criterion but costs nothing and keeps the console from going quiet about
   * a problem it already announced.
   */
  function applyStatusTransition(outcome: SolveOutcome): void {
    const transition = statusTracker.onOutcome(outcome);
    if (transition === null) return;

    deps.broadcaster.status(transition);

    if (transition.level === 'sticky') {
      logger.error(
        `status: the standing status pill is now STICKY (${String(transition.kind)}) -- this will keep failing on every future solve until it's fixed outside the app.`,
      );
    } else if (transition.level === 'silent') {
      logger.info('status: the standing status pill is back to normal.');
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
