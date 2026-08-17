import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_PRELOAD_CONTEXT_CHARS,
  createPreloadContextReader,
} from '../../src/host/context/preload-context.ts';
import type { Logger } from '../../src/host/logger.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
    warnings,
  };
}

describe('createPreloadContextReader', () => {
  it('reads null with no I/O at all when no path is configured', async () => {
    const reader = createPreloadContextReader({
      path: null,
      stat: () => {
        throw new Error('must not be called');
      },
    });

    assert.equal(await reader.read(), null);
  });

  it('reads a plain file verbatim, trimmed', async (t) => {
    const dir = await tempStateRoot(t);
    const path = join(dir, 'notes.md');
    await writeFile(path, '  Prefer iterative solutions.\n');

    const reader = createPreloadContextReader({ path });

    assert.equal(await reader.read(), 'Prefer iterative solutions.');
  });

  it('reads a directory as its direct files, concatenated under name headings, in name order', async (t) => {
    const dir = await tempStateRoot(t);
    await writeFile(join(dir, 'b-style.md'), 'Two-space indent.');
    await writeFile(join(dir, 'a-conventions.md'), 'No semicolons.');

    const reader = createPreloadContextReader({ path: dir });

    assert.equal(
      await reader.read(),
      '## a-conventions.md\n\nNo semicolons.\n\n## b-style.md\n\nTwo-space indent.',
    );
  });

  it('skips subdirectories of a configured directory rather than recursing into them', async (t) => {
    const dir = await tempStateRoot(t);
    await writeFile(join(dir, 'top.md'), 'top-level note');
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', 'inner.md'), 'must not appear');

    const reader = createPreloadContextReader({ path: dir });

    const text = await reader.read();
    assert.equal(text, '## top.md\n\ntop-level note');
    assert.equal(text?.includes('must not appear'), false);
  });

  it('skips a symlink inside a configured directory rather than following it -- CWE-200: a link could otherwise smuggle an arbitrary file elsewhere on disk into every solve request', async (t) => {
    const outside = await tempStateRoot(t);
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'do not send this to the model');

    const dir = await tempStateRoot(t);
    await writeFile(join(dir, 'real.md'), 'real note');
    await symlink(secret, join(dir, 'linked.md'));

    const reader = createPreloadContextReader({ path: dir });

    const text = await reader.read();
    assert.equal(text, '## real.md\n\nreal note');
    assert.equal(text?.includes('do not send this to the model'), false);
  });

  it('reads null, with a logged warning, when the path does not exist', async (t) => {
    const dir = await tempStateRoot(t);
    const { logger, warnings } = capturingLogger();

    const reader = createPreloadContextReader({ path: join(dir, 'missing.md'), logger });

    assert.equal(await reader.read(), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /could not read/);
  });

  it('reads null for an empty file, the same as no file at all', async (t) => {
    const dir = await tempStateRoot(t);
    const path = join(dir, 'empty.md');
    await writeFile(path, '   \n  ');

    const reader = createPreloadContextReader({ path });

    assert.equal(await reader.read(), null);
  });

  it('reads null for an empty directory', async (t) => {
    const dir = await tempStateRoot(t);

    const reader = createPreloadContextReader({ path: dir });

    assert.equal(await reader.read(), null);
  });

  it('truncates content past the size cap, with a trailing marker', async () => {
    const oversized = 'x'.repeat(MAX_PRELOAD_CONTEXT_CHARS + 500);
    const reader = createPreloadContextReader({
      path: '/fake/notes.md',
      stat: async () => ({ isDirectory: () => false, isFile: () => true }),
      readFile: async () => oversized,
    });

    const text = await reader.read();
    assert.ok(text !== null);
    assert.ok(text.startsWith('x'.repeat(100)));
    assert.ok(text.endsWith('[preloaded context truncated: it exceeded the size limit]'));
    assert.ok(text.length < oversized.length);
  });

  it('reads the same path fresh on every call -- a later edit is picked up with no restart', async (t) => {
    const dir = await tempStateRoot(t);
    const path = join(dir, 'notes.md');
    await writeFile(path, 'first version');
    const reader = createPreloadContextReader({ path });

    assert.equal(await reader.read(), 'first version');
    await writeFile(path, 'second version');
    assert.equal(await reader.read(), 'second version');
  });
});
