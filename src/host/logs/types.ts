import type { TranscriptChannel } from '../audio/types.ts';
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
  /**
   * The window this answer was solved against, or `null` when the question
   * was answered from speech alone (`POST /solve/transcript-only`) and no
   * screenshot was ever taken -- see `SolveOutcomeEvent.target` for why this
   * is a null rather than an omission.
   */
  readonly target: TargetWindowIdentity | null;
  /** Present and `true` only when the outcome was `interrupted`. */
  readonly interrupted?: true;
  /**
   * Present and `true` only when recent speech was actually sent to the
   * model with this attempt -- not exclusive to an attempt that also carried
   * a screenshot. See `SolveOutcomeEvent.withTranscript` for the full
   * three-combination matrix against {@link target}.
   */
  readonly withTranscript?: true;
}

/**
 * One `usage.jsonl` line -- written for *every* attempted call, including a
 * bail and an `error` (spec "Usage log"). Pure observability: nothing reads
 * the running total to cap or throttle anything (spec, explicitly).
 */
export interface UsageLogEntry {
  readonly timestamp: string;
  readonly model: string;
  /** `null` for a spoken-only solve -- see {@link AnswerLogEntry.target}. */
  readonly target: TargetWindowIdentity | null;
  readonly outcome: 'done' | 'interrupted' | 'error';
  /**
   * Real token counts for `done`. `interrupted` and `error` outcomes carry
   * no real usage from the provider seam (`SolveOutcome` has no `usage`
   * field on either variant) -- recorded as all-zero, the same documented
   * limitation as `AnswerLogEntry.usage`.
   */
  readonly usage: Usage;
  /**
   * Present and `true` only when a `done` outcome's title was one of the bail
   * markers (`title.ts`'s `BAIL_TITLE` or `NO_QUESTION_TITLE` -- an attempt
   * that answered nothing, whether because the screen held no exercise or
   * because the speech asked no question). Which of the two it was is
   * recoverable from `answers.jsonl`... nowhere, in fact: a bail writes no
   * answer line at all, so the marker itself is not persisted. Reach for the
   * console or re-run if you need to know which; the two are the same fact
   * for cost purposes, which is all this log is for.
   */
  readonly bail?: true;
  /** Present only for an `error` outcome. */
  readonly errorKind?: ProviderErrorKind;
  /**
   * Present and `true` only when recent speech was actually sent to the
   * model with this attempt -- not exclusive to an attempt that also carried
   * a screenshot. See `SolveOutcomeEvent.withTranscript` for the full
   * three-combination matrix against {@link target}.
   */
  readonly withTranscript?: true;
}

/**
 * One `transcript.jsonl` line -- written only for a *final* transcript
 * segment, never an interim one. Interim text is unstable by definition
 * (Deepgram revises it, and a later message supersedes it wholesale), so
 * persisting it would mean writing lines that later become wrong.
 *
 * Single append-only file across every recording session, not one file per
 * session: `recordingSessionId` already provides the grouping, and per-session
 * files would introduce a filesystem naming scheme this app has no other
 * instance of. The third instance of the `jsonl.ts` shape, alongside
 * `answers.jsonl` and `usage.jsonl`.
 */
export interface TranscriptEntry {
  /** A fresh UUID per recording toggle-on -- groups the lines of one sitting. */
  readonly recordingSessionId: string;
  readonly channel: TranscriptChannel;
  readonly text: string;
  /**
   * ISO 8601, UTC, for the END of this segment -- computed host-side as the
   * moment the socket opened plus {@link endSeconds}.
   *
   * This is the only field safe to order by across a reconnect, which is
   * exactly why it exists alongside the offsets below.
   */
  readonly timestamp: string;
  /**
   * Deepgram's own offsets, in seconds from the start of *that socket's*
   * audio. Recorded honestly rather than normalized into a session-wide
   * timeline: they restart at 0 every time the socket reconnects, and
   * inventing a continuous timeline across a gap of unknown length would be
   * fabricating precision this app does not have.
   */
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly model: string;
}
