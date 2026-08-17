import { readdir as readdirFs, readFile as readFileFs, stat as statFs } from 'node:fs/promises';
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

export interface PreloadContextReaderOptions {
  /** `null` (the default in a fresh `config.json`) means the feature is off -- `read()` always resolves `null` with no I/O. */
  readonly path: string | null;
  readonly logger?: Logger;
  /** Injected for tests; production reads the real filesystem. */
  readonly stat?: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
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
  const readFileImpl = options.readFile ?? ((p: string) => readFileFs(p, 'utf8'));
  const readdirImpl = options.readdir ?? ((p: string) => readdirFs(p));

  if (path === null) {
    return { read: () => Promise.resolve(null) };
  }

  return {
    async read(): Promise<string | null> {
      let text: string;
      try {
        text = await readPath(path, { stat: statImpl, readFile: readFileImpl, readdir: readdirImpl });
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
      return trimmed.slice(0, MAX_PRELOAD_CONTEXT_CHARS) + TRUNCATION_MARKER;
    },
  };
}

interface FsDeps {
  readonly stat: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
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
  const info = await fs.stat(path);

  if (info.isFile()) {
    return fs.readFile(path);
  }

  if (!info.isDirectory()) {
    throw new Error(`${path} is neither a file nor a directory`);
  }

  const names = (await fs.readdir(path)).sort((a, b) => a.localeCompare(b));
  const sections: string[] = [];
  for (const name of names) {
    const entryPath = join(path, name);
    const entryInfo = await fs.stat(entryPath);
    if (!entryInfo.isFile()) continue; // subdirectories are skipped, not recursed into
    sections.push(`## ${name}\n\n${await fs.readFile(entryPath)}`);
  }
  return sections.join('\n\n');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
