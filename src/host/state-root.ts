import { mkdir } from 'node:fs/promises';
import { StartupError } from './errors.ts';

/**
 * Make sure the state root exists.
 *
 * The state root is `app.getPath('userData')` — `%APPDATA%\screen-solver\` on
 * Windows. It holds `config.json` (#28), `answers.jsonl` and `usage.jsonl`
 * (#31). Nothing secret is ever written here.
 *
 * @throws {StartupError} `state-root-unwritable` if the directory can't be created.
 */
export async function ensureStateRoot(stateRoot: string): Promise<string> {
  try {
    await mkdir(stateRoot, { recursive: true });
  } catch (cause) {
    throw new StartupError(
      'state-root-unwritable',
      `Could not create the state directory at ${stateRoot}: ${describe(cause)}`,
      { cause },
    );
  }
  return stateRoot;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
