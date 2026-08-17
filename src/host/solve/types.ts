import type { TargetWindowIdentity } from '../config/types.ts';
import type { ProviderErrorKind, Usage } from '../provider/types.ts';

/**
 * The final outcome of one solve attempt -- fired once via
 * `SolveLoopDeps.onOutcome` (`loop.ts`) for every attempt that actually
 * reached the provider. A pre-flight guard failure (vanished/minimized
 * target, black/zero-size frame) is a true no-op and never reaches this bus
 * at all: no wire event, no outcome, no provider call (spec "Not-capturable /
 * bad-frame detection").
 *
 * Deliberately separate from the SSE wire vocabulary (`start`/`delta`/`done`/
 * `error`, see `broadcaster.ts`), which has no `interrupted` kind -- the
 * wire-level experience of an interruption is just "the old stream stops
 * advancing and a fresh `start` begins immediately" (#29's own framing).
 * `interrupted` exists only on this internal bus, for #31 to persist to
 * `answers.jsonl` (tagged `interrupted: true`) the way a `done` outcome gets
 * persisted there too.
 *
 * A small explicit union over a class, matching `ConfigChangeEvent`
 * (`config/types.ts`) and `SolveEvent` (`provider/types.ts`)'s own style.
 */
export type SolveOutcome =
  | {
      readonly type: 'done';
      /** The full accumulated answer text -- every `delta` concatenated in order. */
      readonly text: string;
      readonly usage: Usage;
      readonly stopReason: string | null;
    }
  | {
      readonly type: 'interrupted';
      /** Whatever had accumulated before a newer `POST /solve` superseded this attempt. */
      readonly text: string;
    }
  | {
      readonly type: 'error';
      readonly kind: ProviderErrorKind;
      readonly message: string;
      /** Usually empty, but not always -- the provider seam can fail after some text has already streamed (spec: "stream dies mid-answer"). */
      readonly text: string;
    };

/**
 * What `SolveLoopDeps.onOutcome` (`loop.ts`) actually receives: a
 * {@link SolveOutcome} plus which window and model it belongs to.
 *
 * `SolveOutcome` itself deliberately stays free of these two fields --
 * `target`/`model` would otherwise have to be duplicated across all three
 * union variants for no benefit, since every consumer of the outcome bus
 * needs them regardless of which variant it got. `runAttempt` (`loop.ts`)
 * already has both in scope (`target` is its own parameter; `model` is
 * `deps.provider.model`), so wrapping them at the call site costs nothing
 * there and keeps `SolveOutcome`'s existing "small explicit union" shape
 * (and every test that already destructures it) untouched.
 *
 * #31's persistence layer (`src/host/logs/`) is the one real consumer: it
 * needs `target`/`model` to write `answers.jsonl`/`usage.jsonl` entries, and
 * needs the outcome union to decide *whether* to write one at all.
 */
export interface SolveOutcomeEvent {
  readonly outcome: SolveOutcome;
  /**
   * The window this attempt was solved against, or `null` for a spoken-only
   * solve (`POST /solve/transcript-only`), where no frame was captured and no
   * window was involved.
   *
   * `null` rather than "the window that happened to be configured at the
   * time": recording a target for an attempt that never looked at one would
   * put a claim in `answers.jsonl` that no screenshot supports. It is also the
   * only signal a log reader gets that an answer came from speech alone, which
   * is why it is `null` and not omitted -- a missing field would be
   * indistinguishable from an older line written before this mode existed.
   */
  readonly target: TargetWindowIdentity | null;
  readonly model: string;
  /**
   * Present and `true` only when recent speech was actually sent to the
   * model with this attempt. That is true of *both* transcript-carrying
   * modes -- `POST /solve/with-transcript` and `POST /solve/transcript-only`
   * -- and the flag's meaning hasn't changed since it was introduced with
   * only the first of the two; only the set of routes able to produce it
   * has grown. Absent otherwise, following the existing `interrupted?: true`
   * / `bail?: true` idiom rather than carrying a `false` on every ordinary
   * solve.
   *
   * Combined with {@link target} above, three of the four combinations are
   * reachable, and this is the one place that spells out what each means
   * rather than leaving a log reader to infer it:
   *
   * | `target` | `withTranscript` | route                                                    |
   * |----------|-------------------|-----------------------------------------------------------|
   * | set      | absent            | `POST /solve` -- screenshot alone                          |
   * | set      | `true`            | `POST /solve/with-transcript` -- screenshot plus speech    |
   * | `null`   | `true`            | `POST /solve/transcript-only` -- speech alone, no screenshot ever taken |
   *
   * `target: null` with `withTranscript` absent -- the missing fourth cell --
   * stays missing on purpose: a spoken-only attempt with nothing said never
   * reaches the provider at all (`POST /solve/transcript-only` answers `400
   * no_transcript` before it gets here; `runAttempt`'s own early return in
   * `loop.ts` is the backstop for a window that empties between that check
   * and this one), so no outcome, and no log line, is ever produced for it.
   *
   * A mode-specific marker was considered instead of broadening this
   * comment, and rejected: `target` already discriminates the three modes
   * unambiguously (its own doc comment above already calls it out as "the
   * only signal a log reader gets that an answer came from speech alone"), so
   * a second field encoding the same fact would only be a second field that
   * could someday disagree with it.
   *
   * Recorded so the logs can distinguish an answer the model reached from the
   * screen alone from one it reached with speech in front of it -- the two are
   * not equally reproducible from `answers.jsonl`, since the transcript that
   * shaped the second one is a bounded in-memory window that is gone by the
   * time anyone reads the log.
   */
  readonly withTranscript?: true;
  /**
   * Present and `true` only when preloaded context (`config.json`'s
   * `contextPath`, `context/preload-context.ts`) was actually read and sent
   * with this attempt -- absent when nothing is configured, the configured
   * path didn't resolve to anything readable, or what it resolved to was
   * empty. Same `?: true` idiom as {@link withTranscript}, and independent of
   * it: either, both, or neither can be present on one outcome.
   */
  readonly withPreloadContext?: true;
}
