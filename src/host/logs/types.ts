import type { TargetWindowIdentity } from '../config/types.ts';
import type { ProviderErrorKind, Usage } from '../provider/types.ts';

/**
 * One `answers.jsonl` line -- written only for a `done` (non-bail) or
 * `interrupted` outcome, never a bail or an `error` (spec "Answer log").
 * `text` is the final accumulated answer only -- no delta history, no image.
 */
export interface AnswerLogEntry {
  /**
   * The answer's `#` heading, parsed from `text` (`title.ts`). `null` if no
   * heading had streamed yet -- only possible for an `interrupted` outcome
   * cut off before the first line finished (see `recorder.ts`'s Judgment
   * calls in the #31 PR for why this is recorded honestly rather than
   * papered over with a placeholder).
   */
  readonly title: string | null;
  readonly text: string;
  /** ISO 8601, UTC. */
  readonly timestamp: string;
  readonly model: string;
  /**
   * Real token counts for a `done` outcome. An `interrupted` outcome never
   * receives a `done` event from the provider seam (`SolveOutcome`,
   * `solve/types.ts`), so no real usage exists for it -- recorded as
   * all-zero. A real limitation (there is no way to know what an
   * interrupted call actually cost), not a design choice.
   */
  readonly usage: Usage;
  /** The window this answer was solved against. */
  readonly target: TargetWindowIdentity;
  /** Present and `true` only when the outcome was `interrupted`. */
  readonly interrupted?: true;
}

/**
 * One `usage.jsonl` line -- written for *every* attempted call, including a
 * bail and an `error` (spec "Usage log"). Pure observability: nothing reads
 * the running total to cap or throttle anything (spec, explicitly).
 */
export interface UsageLogEntry {
  readonly timestamp: string;
  readonly model: string;
  readonly target: TargetWindowIdentity;
  readonly outcome: 'done' | 'interrupted' | 'error';
  /**
   * Real token counts for `done`. `interrupted` and `error` outcomes carry
   * no real usage from the provider seam (`SolveOutcome` has no `usage`
   * field on either variant) -- recorded as all-zero, the same documented
   * limitation as `AnswerLogEntry.usage`.
   */
  readonly usage: Usage;
  /** Present and `true` only when a `done` outcome's title was the v1 bail marker (`title.ts`). */
  readonly bail?: true;
  /** Present only for an `error` outcome. */
  readonly errorKind?: ProviderErrorKind;
}
