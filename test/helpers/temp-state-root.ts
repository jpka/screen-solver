import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/**
 * A throwaway stand-in for `app.getPath('userData')`, cleaned up after the test.
 *
 * The returned path exists; pass `{ created: false }` when the test needs to
 * assert that startup creates it.
 */
export async function tempStateRoot(
  t: TestContext,
  options: { created?: boolean } = {},
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'screen-solver-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return options.created === false ? join(base, 'state', 'root') : base;
}
