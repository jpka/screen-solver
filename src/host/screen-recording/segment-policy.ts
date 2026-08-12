/**
 * When to roll to a fresh segment (#47). Pure -- no clock, no disk, no state.
 *
 * Rolling is what keeps a continuous recording usable at all. One unbounded
 * file would be unplayable until the recording stopped, impossible to prune
 * without rewriting, and would lose everything to a single corrupt write.
 * Segments make the recording a list of independently playable, independently
 * deletable units, which is what both `retention.ts` and the client's playback
 * list are built on.
 *
 * The decision lives here rather than in the renderer for two reasons: only the
 * host knows the byte count (only the host writes to disk), and `src/main`'s
 * standing rule is that the renderer decides nothing.
 */

/**
 * Hard byte ceiling on one segment, independent of the configured duration.
 *
 * A busy full-screen capture can produce far more data per minute than a mostly
 * static window, so a purely time-based roll makes segment size unpredictable
 * -- and the thing that actually hurts is a single file large enough to be
 * awkward to seek, serve, or delete. 256 MiB is comfortably above what the
 * 5-minute default produces from a typical window capture, so in normal use
 * this never fires; it exists so the pathological case is bounded rather than
 * unbounded.
 */
export const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;

export interface SegmentRollInput {
  /** Wall-clock milliseconds since the current segment opened. */
  readonly elapsedMs: number;
  /** Bytes handed to the writer for the current segment so far. */
  readonly bytes: number;
  /** `ScreenRecordingSettings.segmentSeconds`, already clamped by the config store. */
  readonly segmentSeconds: number;
  /** Overridable for tests; production uses {@link MAX_SEGMENT_BYTES}. */
  readonly maxSegmentBytes?: number;
}

/**
 * Whether the current segment should end now -- whichever of the two limits is
 * reached first.
 *
 * Both bounds are `>=` rather than `>`: a segment that has hit its limit
 * exactly has satisfied it, and using `>` would mean the roll always happens
 * one chunk late.
 */
export function shouldRollSegment(input: SegmentRollInput): boolean {
  const maxBytes = input.maxSegmentBytes ?? MAX_SEGMENT_BYTES;
  return input.elapsedMs >= input.segmentSeconds * 1_000 || input.bytes >= maxBytes;
}
