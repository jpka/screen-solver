import { Buffer } from 'node:buffer';
import { lstat as lstatFs, open as openFs, readdir as readdirFs, stat as statFs } from 'node:fs/promises';
import { join } from 'node:path';
import { silentLogger, type Logger } from '../logger.ts';

/**
 * The reference material a user preloads ahead of time -- site conventions, a
 * style guide, a reminder of which patterns to prefer -- pointed at by
 * `config.json`'s `contextPath` (`config/types.ts`) and sent alongside every
 * solve as a second, uncached system block (`provider/anthropic.ts`'s
 * `wrapPreloadContext`).
 *
 * Read fresh on every call rather than cached at startup, the same "read at
 * the instant it's needed" idea `solve/loop.ts` already uses for the target
 * window and the transcript window: the whole point of a *file* over a
 * one-time config value is that editing it between solves takes effect
 * without a restart.
 */
export interface PreloadContextReader {
  /**
   * `null` when no path is configured, the path doesn't resolve to anything
   * readable, or what it resolves to is empty -- every failure mode collapses
   * to "there is no preloaded context for this attempt" (the same safe
   * default every optional dependency in this codebase falls back to), never
   * a thrown error that would abort a solve over a typo in a config path.
   */
  read(): Promise<string | null>;
}

/**
 * Above this, a preloaded-context block would cost more tokens than the
 * answer it's meant to inform, and risks crowding the model's attention off
 * the screenshot the system prompt names as authoritative. Content beyond the
 * cap is dropped with a trailing marker rather than silently cut, so a user
 * whose notes have outgrown this sees why the tail is missing instead of just
 * losing it.
 */
export const MAX_PRELOAD_CONTEXT_CHARS = 20_000;

const TRUNCATION_MARKER = '\n\n[preloaded context truncated: it exceeded the size limit]';

/**
 * The byte budget for one file read (top-level file or directory entry),
 * head-only rather than the whole file. 4 bytes/char is UTF-8's own worst
 * case, so this comfortably covers {@link MAX_PRELOAD_CONTEXT_CHARS}
 * characters of anything the encoding can produce, with slack to spare.
 *
 * Reading a bounded head instead of the whole file (review fix) is what keeps
 * a misconfigured `contextPath` -- pointed at a huge file by accident, or a
 * directory holding one -- from fully materializing that file in memory, and
 * spending the time to do so, on every single solve attempt only to throw
 * away everything past {@link MAX_PRELOAD_CONTEXT_CHARS} a moment later.
 */
const MAX_READ_BYTES = MAX_PRELOAD_CONTEXT_CHARS * 4;

export interface PreloadContextReaderOptions {
  /** `null` (the default in a fresh `config.json`) means the feature is off -- `read()` always resolves `null` with no I/O. */
  readonly path: string | null;
  readonly logger?: Logger;
  /** Injected for tests; production reads the real filesystem. */
  readonly stat?: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  /** Injected for tests; production `lstat`s the real filesystem -- see {@link readPath} for why this, and not {@link stat}, decides which directory entries get read. */
  readonly lstat?: (path: string) => Promise<{ isFile(): boolean }>;
  /** Injected for tests; production reads at most {@link MAX_READ_BYTES} off the front of the real file, never the whole thing. */
  readonly readFile?: (path: string) => Promise<string>;
  readonly readdir?: (path: string) => Promise<string[]>;
}

/**
 * Builds a reader fixed to one path for the process's lifetime -- there is no
 * live setter for `contextPath` (see its doc comment in `config/types.ts`),
 * so the path itself only ever changes across a restart, even though the
 * file or folder it points to can change freely between solves.
 */
export function createPreloadContextReader(options: PreloadContextReaderOptions): PreloadContextReader {
  const { path } = options;
  const logger = options.logger ?? silentLogger;
  const statImpl = options.stat ?? statFs;
  const lstatImpl = options.lstat ?? lstatFs;
  const readFileImpl = options.readFile ?? ((p: string) => readHeadBytes(p, MAX_READ_BYTES));
  const readdirImpl = options.readdir ?? ((p: string) => readdirFs(p));

  if (path === null) {
    return { read: () => Promise.resolve(null) };
  }

  return {
    async read(): Promise<string | null> {
      let text: string;
      try {
        text = await readPath(path, {
          stat: statImpl,
          lstat: lstatImpl,
          readFile: readFileImpl,
          readdir: readdirImpl,
        });
      } catch (error) {
        // Misconfiguration (a typo'd path, a folder that got moved, a
        // permissions change) must degrade the same way a vanished target
        // window does -- surfaced on the console, never a failed solve, since
        // the model can still answer from the screen alone.
        logger.warn(`preload context: could not read "${path}": ${describeError(error)} -- sending no preloaded context this solve.`);
        return null;
      }

      const trimmed = text.trim();
      if (trimmed === '') return null;
      if (trimmed.length <= MAX_PRELOAD_CONTEXT_CHARS) return trimmed;
      // The marker's own length is reserved out of the budget, not appended
      // on top of it (review fix) -- the returned value never exceeds
      // MAX_PRELOAD_CONTEXT_CHARS, marker included.
      const budget = Math.max(0, MAX_PRELOAD_CONTEXT_CHARS - TRUNCATION_MARKER.length);
      return trimmed.slice(0, budget) + TRUNCATION_MARKER;
    },
  };
}

/**
 * Reads at most `maxBytes` off the front of a file, decoded as UTF-8.
 *
 * A read that lands mid-multi-byte-character at the very end of the window
 * decodes that trailing fragment as a replacement character rather than
 * throwing -- the same tradeoff `MAX_READ_BYTES`'s own comment accepts: this
 * is preloaded reference material, not code, and the far more common case
 * (a file under the byte budget entirely) is unaffected.
 */
async function readHeadBytes(path: string, maxBytes: number): Promise<string> {
  const handle = await openFs(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

interface FsDeps {
  readonly stat: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readonly lstat: (path: string) => Promise<{ isFile(): boolean }>;
  readonly readFile: (path: string) => Promise<string>;
  readonly readdir: (path: string) => Promise<string[]>;
}

/**
 * A file's contents verbatim; a directory's *direct* children only (no
 * recursion -- an unbounded walk of an arbitrary folder is a scope this
 * feature doesn't need), each read and concatenated under a `## <filename>`
 * heading, in name order for a stable, deterministic block across repeated
 * reads.
 */
async function readPath(path: string, fs: FsDeps): Promise<string> {
  // `stat`, not `lstat`, for the top-level path: it's the exact string the
  // user put in `config.json`, so following a symlink there is the same as
  // if they'd typed the target path directly.
  const info = await fs.stat(path);

  if (info.isFile()) {
    return fs.readFile(path);
  }

  if (!info.isDirectory()) {
    throw new Error(`${path} is neither a file nor a directory`);
  }

  const names = (await fs.readdir(path)).sort((a, b) => a.localeCompare(b));
  const sections: string[] = [];
  let accumulated = 0;
  for (const name of names) {
    // Stops opening further entries once there's already enough to fill the
    // cap -- a directory of many large files would otherwise pay the read
    // cost (bounded per-file, but not in aggregate) for every entry before
    // the final trim below discards everything past the cap anyway.
    if (accumulated >= MAX_PRELOAD_CONTEXT_CHARS) break;

    const entryPath = join(path, name);
    // `lstat`, not `stat`, for a *directory entry*: `stat` follows a symlink
    // to whatever it points at and would report `isFile()` for a link
    // pointing anywhere on disk, which `fs.readFile` below would then happily
    // read and send to the model -- an entry a user never explicitly
    // configured, unlike the top-level path above. `lstat` reports the
    // symlink itself, which is never a plain file, so a symlink is skipped
    // exactly like a subdirectory: not recursed into, not followed.
    const entryInfo = await fs.lstat(entryPath);
    if (!entryInfo.isFile()) continue;
    const section = `## ${name}\n\n${await fs.readFile(entryPath)}`;
    sections.push(section);
    accumulated += section.length;
  }
  return sections.join('\n\n');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
