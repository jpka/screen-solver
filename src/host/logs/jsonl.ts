import { Buffer } from 'node:buffer';
import { appendFile as appendFileFs, open as openFs, readFile as readFileFs } from 'node:fs/promises';

/**
 * One append-only JSONL file: one JSON object per line, read back fresh on
 * every call (no in-memory cache to keep in sync with the file -- `GET
 * /answers`'s own requirement, spec "GET /answers ... independent of the
 * live /events connection").
 *
 * The reusable half of `answers.jsonl` / `usage.jsonl` (spec "Answer log" /
 * "Usage log", #31) -- `answer-log.ts` and `usage-log.ts` are both thin
 * wrappers around this with a fixed filename and entry type. A status log
 * (#32) is expected to be a third instance of exactly this shape.
 *
 * Durability: `appendFile`'s default (`fs.promises.appendFile`, flag `'a'`)
 * opens the file in OS append mode, so this process's own concurrent/rapid
 * appends land at the file's current end rather than racing each other for a
 * write position -- each call's `write()` is a single syscall under typical
 * line lengths here, which POSIX/NTFS append semantics make atomic against
 * each other. What this does *not* protect against, and what the spec
 * already accepts as a known limitation ("a mid-stream crash loses that
 * answer's text"): a process kill mid-write can still truncate the line
 * being written to a partial, unparseable fragment. `readAll()` below does
 * not attempt to recover a truncated trailing line -- a corrupt last line
 * throws out of `JSON.parse` rather than being silently dropped, since
 * silently dropping data on read is a worse failure mode than a visible
 * startup error for something this rare.
 */
export interface JsonlFile<T> {
  /** Appends one JSON-encoded line. */
  append(entry: T): Promise<void>;
  /** Reads and parses every line currently on disk. `[]` if the file doesn't exist yet. */
  readAll(): Promise<T[]>;
  /**
   * The last `maxEntries` lines, without reading the whole file.
   *
   * `answers.jsonl` grows one line per button press and can afford
   * {@link readAll} forever. `transcript.jsonl` grows one line every few
   * seconds of speech, so over a few months of use "read and parse the entire
   * history, then throw away all but the last 500" is work proportional to
   * everything ever said -- on every single request, and duplicated in memory
   * across concurrent ones (review feedback on the transcript PR: the route
   * bounded its *response* but not its *read*).
   *
   * Reads a bounded window off the end of the file instead. The window is
   * sized from `maxEntries` with a generous per-line allowance, so the result
   * is the same as `readAll().slice(-maxEntries)` in every realistic case; a
   * file whose lines are far larger than the allowance yields fewer entries
   * rather than reading unboundedly, which is the right way for this to
   * degrade.
   */
  readTail(maxEntries: number): Promise<T[]>;
}

/**
 * Per-entry byte allowance when sizing a {@link JsonlFile.readTail} window.
 * A real `transcript.jsonl` line runs ~250 bytes, so this is roughly double
 * the realistic worst case -- deliberately slack, since the cost of
 * over-reading is a slightly larger buffer while the cost of under-reading is
 * silently returning fewer entries than asked for.
 */
const TAIL_BYTES_PER_ENTRY = 512;

/** Absorbs the partial first line a mid-file read almost always starts on, plus slack. */
const TAIL_SLACK_BYTES = 64 * 1024;

/** What a tail read returns: the bytes, and whether it started mid-file. */
export interface TailRead {
  readonly text: string;
  /** True when the read began past byte 0, so `text` opens on a partial line. */
  readonly truncated: boolean;
}

export interface JsonlFileOptions {
  readonly path: string;
  /** Injected for tests; production appends to the real file. */
  readonly appendFile?: (path: string, contents: string) => Promise<void>;
  /** Injected for tests; production reads the real file. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Injected for tests; production reads the real file's tail. */
  readonly readTailBytes?: (path: string, maxBytes: number) => Promise<TailRead>;
}

/**
 * Reads at most the last `maxBytes` of a file.
 *
 * Positional rather than whole-file, which is the entire point. Slicing at a
 * byte offset can land mid-UTF-8-sequence, but that damage is always confined
 * to the first line -- which {@link openJsonlFile}'s `readTail` discards
 * whenever `truncated` is set, since a mid-file read opens on a partial record
 * regardless of encoding.
 */
async function readTailBytesFs(path: string, maxBytes: number): Promise<TailRead> {
  const handle = await openFs(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length === 0) return { text: '', truncated: false };

    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString('utf8'), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

export function openJsonlFile<T>(options: JsonlFileOptions): JsonlFile<T> {
  const { path } = options;
  const appendFileImpl = options.appendFile ?? ((p: string, c: string) => appendFileFs(p, c, 'utf8'));
  const readFileImpl = options.readFile ?? ((p: string) => readFileFs(p, 'utf8'));
  const readTailBytesImpl = options.readTailBytes ?? readTailBytesFs;

  return {
    async append(entry: T): Promise<void> {
      await appendFileImpl(path, `${JSON.stringify(entry)}\n`);
    },

    async readAll(): Promise<T[]> {
      let raw: string;
      try {
        raw = await readFileImpl(path);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      return raw
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as T);
    },

    async readTail(maxEntries: number): Promise<T[]> {
      if (maxEntries <= 0) return [];

      let tail: TailRead;
      try {
        tail = await readTailBytesImpl(path, maxEntries * TAIL_BYTES_PER_ENTRY + TAIL_SLACK_BYTES);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }

      const lines = tail.text.split('\n');
      // A read that began past byte 0 opens partway through whatever record
      // happened to straddle the boundary. That fragment is not a JSON object
      // and must never reach `JSON.parse` -- unlike `readAll`'s deliberate
      // refusal to paper over a truncated *trailing* line (which means real
      // corruption on disk), this one is an artifact of where we chose to
      // start reading and is expected on every non-trivial call.
      if (tail.truncated) lines.shift();

      const entries = lines
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as T);
      return entries.length > maxEntries ? entries.slice(-maxEntries) : entries;
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
