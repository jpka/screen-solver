import { join } from 'node:path';
import { openJsonlFile, type JsonlFile } from './jsonl.ts';
import type { RecordingLogEntry, RecordingSegment } from './types.ts';

export const RECORDING_LOG_FILE_NAME = 'recordings.jsonl';

/** Where segment files live, alongside `recordings.jsonl` under the state root. */
export const RECORDINGS_DIR_NAME = 'recordings';

export interface RecordingLog extends JsonlFile<RecordingLogEntry> {
  /**
   * Every segment that still exists on disk, folded from the raw event log and
   * ordered **newest first** -- the order `GET /recordings` serves and the
   * reverse of the order `retention.ts` prunes in.
   *
   * Read fresh on every call, like `readAll()`: `GET /recordings` needs to see
   * a segment that the writer appended a moment ago without any cache
   * invalidation between them.
   */
  readIndex(): Promise<readonly RecordingSegment[]>;
}

export interface RecordingLogOptions {
  readonly stateRoot: string;
  readonly appendFile?: (path: string, contents: string) => Promise<void>;
  readonly readFile?: (path: string) => Promise<string>;
}

/** `recordings.jsonl` under the state root -- the fourth instance of `jsonl.ts`'s shape, plus a fold. */
export function createRecordingLog(options: RecordingLogOptions): RecordingLog {
  const file = openJsonlFile<RecordingLogEntry>({
    path: join(options.stateRoot, RECORDING_LOG_FILE_NAME),
    appendFile: options.appendFile,
    readFile: options.readFile,
  });

  return {
    append: file.append,
    readAll: file.readAll,
    async readIndex(): Promise<readonly RecordingSegment[]> {
      return foldRecordingLog(await file.readAll());
    },
  };
}

/**
 * Folds the raw append-only event log into current segments.
 *
 * Exported standalone so the fold is directly unit-testable against a
 * hand-written entry list, without a file: the interesting cases are all
 * orderings (`closed` before its `opened` can't happen, but a `pruned` for an
 * id that was never opened can, if an earlier version's log is read by a later
 * one) rather than anything to do with I/O.
 *
 * A `closed` or `pruned` for an unknown id is ignored rather than throwing.
 * The log is the only record of what happened; refusing to read the whole file
 * because one line refers to a segment whose `opened` line predates something
 * is a worse failure than skipping that line.
 */
export function foldRecordingLog(entries: readonly RecordingLogEntry[]): readonly RecordingSegment[] {
  const byId = new Map<string, RecordingSegment>();
  const pruned = new Set<string>();

  for (const entry of entries) {
    if (entry.type === 'opened') {
      byId.set(entry.id, {
        id: entry.id,
        startedAt: entry.startedAt,
        endedAt: null,
        bytes: 0,
        durationMs: null,
        mimeType: entry.mimeType,
        target: entry.target,
      });
      continue;
    }

    if (entry.type === 'pruned') {
      pruned.add(entry.id);
      byId.delete(entry.id);
      continue;
    }

    const open = byId.get(entry.id);
    if (open === undefined) continue;
    byId.set(entry.id, {
      ...open,
      endedAt: entry.endedAt,
      bytes: entry.bytes,
      durationMs: durationBetween(open.startedAt, entry.endedAt),
      ...(entry.recovered === true ? { recovered: true as const } : {}),
    });
  }

  // Newest first. Sorted on `startedAt` rather than trusting append order:
  // append order *is* chronological today, but the two are different claims,
  // and a consumer that renders a list has no way to notice if they diverge.
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function durationBetween(startedAt: string, endedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}
