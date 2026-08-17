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

  it('truncates content past the size cap, with a trailing marker, never exceeding the cap itself', async () => {
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
    // Review fix: the marker used to be appended on top of a full-length
    // slice, so the returned value could run a few dozen characters past the
    // cap it's supposed to be. The marker's length is now reserved out of the
    // budget instead.
    assert.equal(text.length, MAX_PRELOAD_CONTEXT_CHARS, 'the cap is a real ceiling, marker included');
  });

  it('reads only a bounded head of a real file far larger than the cap, rather than materializing all of it', async (t) => {
    const dir = await tempStateRoot(t);
    const path = join(dir, 'huge.md');
    // Larger than MAX_READ_BYTES (4x MAX_PRELOAD_CONTEXT_CHARS), not just
    // larger than the char cap -- proves the real default readFile
    // implementation (a bounded head-read, not the old whole-file read) still
    // produces a correctly truncated result for a file bigger than its own
    // read window, not just bigger than the final cap.
    await writeFile(path, 'y'.repeat(MAX_PRELOAD_CONTEXT_CHARS * 5));

    const reader = createPreloadContextReader({ path });

    const text = await reader.read();
    assert.ok(text !== null);
    assert.equal(text.length, MAX_PRELOAD_CONTEXT_CHARS);
    assert.ok(text.endsWith('[preloaded context truncated: it exceeded the size limit]'));
  });

  it('stops reading further directory entries once enough content has already been gathered', async () => {
    // Content-based assertions alone can't distinguish "stopped early" from
    // "read everything, then the final trim discarded the tail" -- both look
    // identical from the returned string when the first entry alone already
    // exceeds the cap, which is exactly this scenario. Asserting on the I/O
    // call count is what actually proves the second entry was never opened.
    const touched: string[] = [];
    const reader = createPreloadContextReader({
      path: '/fake/dir',
      stat: async () => ({ isDirectory: () => true, isFile: () => false }),
      readdir: async () => ['a-big.md', 'z-should-not-be-touched.md'],
      lstat: async (p) => {
        touched.push(p);
        return { isFile: () => true };
      },
      readFile: async () => 'x'.repeat(MAX_PRELOAD_CONTEXT_CHARS + 500),
    });

    const text = await reader.read();
    assert.ok(text !== null);
    assert.deepEqual(touched, ['/fake/dir/a-big.md'], 'the second entry is never lstat\'d, let alone read');
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
