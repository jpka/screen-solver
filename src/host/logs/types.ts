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
 * One `recordings.jsonl` line (#47).
 *
 * Unlike `answers.jsonl`/`usage.jsonl`, where one line *is* one record, this
 * file is an append-only **event log** folded on read (`recording-log.ts`'s
 * `readIndex`). Three things forced that:
 *
 * 1. A segment's `bytes` and `endedAt` aren't known when it starts, and the
 *    whole crash-safety premise of this subsystem is that a segment killed
 *    mid-write is still on disk and still playable. Writing one line at close
 *    would mean a crashed segment had no index entry at all -- an orphan file
 *    nothing could list. So `opened` is written before any bytes exist and
 *    `closed` completes it.
 * 2. Retention deletes segments, and `jsonl.ts` has no delete. A `pruned`
 *    tombstone keeps the file strictly append-only (`fs.appendFile`'s `'a'`
 *    mode is the durability property the whole `logs/` directory rests on)
 *    rather than introducing a rewrite path that could truncate the index on
 *    a crash -- trading a real durability guarantee for disk space that
 *    `retention.ts` is already bounding.
 * 3. It keeps `openJsonlFile` reusable as-is, which is what AGENTS.md says a
 *    fourth log should be.
 *
 * Known limit, worth stating rather than hiding: the index itself is never
 * compacted, so it grows by three lines per segment forever even as the
 * segments themselves are pruned. At a 5-minute default segment that is a few
 * thousand lines a year -- immaterial next to the video, and cheap to compact
 * later behind the same `readIndex` fold.
 */
export type ScreenRecordingLogEntry =
  | {
      readonly type: 'opened';
      readonly id: string;
      /** ISO 8601, UTC. */
      readonly startedAt: string;
      /** The container the renderer negotiated -- decides the file extension and the served `content-type`. */
      readonly mimeType: string;
      /** The window being captured when this segment opened, or `null` if that was somehow unknown. */
      readonly target: TargetWindowIdentity | null;
    }
  | {
      readonly type: 'closed';
      readonly id: string;
      readonly endedAt: string;
      readonly bytes: number;
      /**
       * Present and `true` when this close was synthesized at startup for a
       * segment whose `opened` line had no matching `closed` -- i.e. the app
       * died mid-segment. The file is intact up to the last chunk that landed;
       * this flag is what distinguishes "ended because the user stopped" from
       * "ended because the process did".
       */
      readonly recovered?: true;
    }
  | {
      readonly type: 'pruned';
      readonly id: string;
      readonly prunedAt: string;
    };

/** One folded segment, as `GET /recordings` serves it and `retention.ts` reasons about it. */
export interface ScreenRecordingSegment {
  readonly id: string;
  readonly startedAt: string;
  /** `null` while this segment is still being written. */
  readonly endedAt: string | null;
  readonly bytes: number;
  /** `null` while still being written, or if `endedAt` was unparseable. */
  readonly durationMs: number | null;
  readonly mimeType: string;
  readonly target: TargetWindowIdentity | null;
  readonly recovered?: true;
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
