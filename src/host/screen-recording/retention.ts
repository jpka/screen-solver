import type { ScreenRecordingSegment } from '../logs/types.ts';

/**
 * Which segments to delete (#47). Pure -- takes a folded index and the limits,
 * returns ids. Nothing here touches the disk.
 *
 * This is genuinely new ground for this repo: nothing prunes anything today.
 * `answers.jsonl` and `usage.jsonl` grow forever and that is fine, because a
 * line of text is nothing. Video is not nothing -- an unattended recorder with
 * no retention fills the disk, and a full disk is a failure that reaches well
 * past this app. So retention is not a nicety here, it is the thing that makes
 * "leave it running" a safe thing to tell a user.
 *
 * Two independent bounds, either of which can select a segment:
 *
 * - **Age**: anything that ended longer ago than `retentionDays`.
 * - **Total size**: oldest-first until the retained total fits `retentionBytes`.
 *
 * Age is applied first so the byte budget is computed over what age already
 * kept, rather than the two fighting over the same segments.
 */

export interface RetentionInput {
  /** The folded index, in any order -- this function sorts what it needs. */
  readonly segments: readonly ScreenRecordingSegment[];
  readonly retentionBytes: number;
  readonly retentionDays: number;
  /** Now, injected so the age rule is testable without waiting. */
  readonly now: Date;
  /**
   * The segment currently being written, if any. Never selected.
   *
   * Without this, a `retentionBytes` smaller than one segment would delete the
   * file out from under the open handle on the very first roll -- the writer
   * would keep appending to an unlinked inode, and the recording would vanish
   * as it was made. The open segment is also the one the user is most likely
   * to want.
   */
  readonly openSegmentId?: string | null;
}

/**
 * Ids to delete, **oldest first** -- the order they should actually be
 * unlinked in, so an interrupted prune has still made progress on the segments
 * that mattered least.
 */
export function selectSegmentsToPrune(input: RetentionInput): readonly string[] {
  const openId = input.openSegmentId ?? null;
  const candidates = input.segments
    .filter((segment) => segment.id !== openId)
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const doomed = new Set<string>();

  if (input.retentionDays > 0) {
    const cutoff = input.now.getTime() - input.retentionDays * 24 * 60 * 60 * 1_000;
    for (const segment of candidates) {
      // Judged on `endedAt`, falling back to `startedAt` for a segment that
      // never got a `closed` line. Using the *end* is what makes the rule mean
      // "this recording is older than N days" rather than "this recording
      // *began* more than N days ago", which for a long segment are different
      // claims and only the first is what a retention window promises.
      const ended = Date.parse(segment.endedAt ?? segment.startedAt);
      if (!Number.isNaN(ended) && ended < cutoff) doomed.add(segment.id);
    }
  }

  // Then the byte budget, over whatever age left behind. Walking newest-first
  // and keeping until the budget runs out is the same selection as walking
  // oldest-first and dropping until it fits, but it states the intent directly:
  // the newest recordings are the ones worth keeping.
  let retained = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const segment = candidates[i]!;
    if (doomed.has(segment.id)) continue;
    retained += segment.bytes;
    if (retained > input.retentionBytes) doomed.add(segment.id);
  }

  return candidates.filter((segment) => doomed.has(segment.id)).map((segment) => segment.id);
}
