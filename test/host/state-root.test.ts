import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { StartupError } from '../../src/host/errors.ts';
import { ensureStateRoot } from '../../src/host/state-root.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

describe('ensureStateRoot', () => {
  it('creates the directory when it does not exist', async (t) => {
    const stateRoot = await tempStateRoot(t, { created: false });

    await ensureStateRoot(stateRoot);

    assert.ok((await stat(stateRoot)).isDirectory());
  });

  it('is a no-op when the directory already exists', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const marker = join(stateRoot, 'config.json');
    await writeFile(marker, '{}');

    await ensureStateRoot(stateRoot);

    assert.ok((await stat(marker)).isFile(), 'existing contents survive');
  });

  it('refuses to start when the path is blocked by a file', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const blocked = join(stateRoot, 'blocked');
    await writeFile(blocked, 'not a directory');

    await assert.rejects(
      () => ensureStateRoot(join(blocked, 'screen-solver')),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.equal(error.kind, 'state-root-unwritable');
        return true;
      },
    );
  });
});
