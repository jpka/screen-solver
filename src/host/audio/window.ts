import type { TranscriptEntry } from '../logs/types.ts';
import type { TranscriptChannel } from './types.ts';

/**
 * The bounded slice of recent speech that "Solve with transcript" sends to the
 * model.
 *
 * A pure in-memory buffer over final segments — no disk, no clock of its own
 * beyond an injectable `now`, so the eviction rules are unit-testable. It is
 * deliberately *not* backed by a `transcript.jsonl` read: the log grows without
 * limit, and reading it back to answer "what was said in the last five
 * minutes" would make every solve pay for the whole history.
 */

/**
 * Five minutes. The question being answered is about what is on screen *now*,
 * and speech from before that is far more likely to be a different problem
 * than useful context for this one.
 */
export const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/**
 * ~2k tokens, roughly $0.006 per solve at Sonnet input rates.
 *
 * A second, independent bound is needed because time alone does not bound
 * cost: five minutes of a fast talker is unbounded text, and the whole point
 * of a windowed context is that its price is predictable.
 */
export const DEFAULT_MAX_CHARS = 8_000;

/** How each channel introduces itself to the model. */
const SPEAKER_LABELS: Record<TranscriptChannel, string> = {
  them: 'Them',
  me: 'Me',
};

export interface TranscriptWindowOptions {
  readonly maxAgeMs?: number;
  readonly maxChars?: number;
}

export interface TranscriptWindow {
  /** Finals only. Interim text is unstable and would inject duplicated fragments. */
  add(entry: TranscriptEntry): void;
  /**
   * The window as `Them: …` lines, oldest first, or `null` when there is
   * nothing to say.
   *
   * `null` rather than `''` on purpose: it makes "send no transcript block at
   * all" the caller's obvious branch. An empty `<recent_transcript>` block is
   * worse than none — it tells the model speech was captured and there wasn't
   * any, which is a different claim from "no transcript is available".
   */
  render(now?: number): string | null;
  /** Drops everything — called when a recording session ends, so the next one starts clean. */
  clear(): void;
}

interface WindowedEntry {
  readonly atMs: number;
  readonly line: string;
}

export function createTranscriptWindow(options: TranscriptWindowOptions = {}): TranscriptWindow {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  let entries: WindowedEntry[] = [];

  /**
   * Both bounds trim from the *oldest* end. For age that is the only
   * meaningful direction; for the character cap it is a real choice, and the
   * recent end wins because the most recent sentence is the one most likely to
   * be the question actually being asked.
   */
  function evict(nowMs: number): void {
    const cutoff = nowMs - maxAgeMs;
    let firstLive = 0;
    while (firstLive < entries.length && (entries[firstLive]?.atMs ?? 0) < cutoff) {
      firstLive += 1;
    }
    if (firstLive > 0) entries = entries.slice(firstLive);

    let total = 0;
    for (const entry of entries) total += entry.line.length + 1;
    let firstKept = 0;
    while (total > maxChars && firstKept < entries.length) {
      total -= (entries[firstKept]?.line.length ?? 0) + 1;
      firstKept += 1;
    }
    if (firstKept > 0) entries = entries.slice(firstKept);
  }

  return {
    add(entry) {
      const atMs = Date.parse(entry.timestamp);
      entries.push({
        // A line whose timestamp we can't read still belongs in the window --
        // treating it as "now" keeps it for a full window rather than
        // discarding real speech over a formatting problem.
        atMs: Number.isNaN(atMs) ? Date.now() : atMs,
        line: `${SPEAKER_LABELS[entry.channel]}: ${entry.text}`,
      });
    },

    render(now = Date.now()) {
      evict(now);
      if (entries.length === 0) return null;
      return entries.map((entry) => entry.line).join('\n');
    },

    clear() {
      entries = [];
    },
  };
}
