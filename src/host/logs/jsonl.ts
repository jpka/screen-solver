import { appendFile as appendFileFs, readFile as readFileFs } from 'node:fs/promises';

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
}

export interface JsonlFileOptions {
  readonly path: string;
  /** Injected for tests; production appends to the real file. */
  readonly appendFile?: (path: string, contents: string) => Promise<void>;
  /** Injected for tests; production reads the real file. */
  readonly readFile?: (path: string) => Promise<string>;
}

export function openJsonlFile<T>(options: JsonlFileOptions): JsonlFile<T> {
  const { path } = options;
  const appendFileImpl = options.appendFile ?? ((p: string, c: string) => appendFileFs(p, c, 'utf8'));
  const readFileImpl = options.readFile ?? ((p: string) => readFileFs(p, 'utf8'));

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
