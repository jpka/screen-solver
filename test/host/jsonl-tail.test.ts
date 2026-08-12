import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { openJsonlFile } from '../../src/host/logs/jsonl.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * `readTail` (review feedback on the transcript PR): `transcript.jsonl` grows
 * one line every few seconds of speech, so `GET /transcript` bounding its
 * *response* while reading the *whole file* meant work proportional to
 * everything ever said, on every request.
 *
 * Exercised against real files on disk rather than an injected reader,
 * because the whole point of the change is the positional read -- the
 * interesting cases (a window that starts mid-record, a multi-byte character
 * straddling that boundary) only exist at the filesystem layer.
 */

interface Entry {
  readonly n: number;
  readonly text: string;
}

async function fileWith(t: TestContext, lines: readonly string[]): Promise<string> {
  const path = join(await tempStateRoot(t), 'entries.jsonl');
  await writeFile(path, lines.map((line) => `${line}\n`).join(''), 'utf8');
  return path;
}

function entries(count: number, padding = ''): string[] {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({ n: i, text: `line ${i}${padding}` }),
  );
}

describe('JsonlFile.readTail', () => {
  it('returns [] when the file does not exist yet', async (t) => {
    const file = openJsonlFile<Entry>({ path: join(await tempStateRoot(t), 'missing.jsonl') });
    assert.deepEqual(await file.readTail(10), []);
  });

  it('returns [] for a non-positive limit without touching the disk', async (t) => {
    const file = openJsonlFile<Entry>({ path: join(await tempStateRoot(t), 'missing.jsonl') });
    assert.deepEqual(await file.readTail(0), []);
    assert.deepEqual(await file.readTail(-5), []);
  });

  it('returns the NEWEST entries, not the oldest', async (t) => {
    const file = openJsonlFile<Entry>({ path: await fileWith(t, entries(10)) });
    const tail = await file.readTail(3);
    assert.deepEqual(tail.map((e) => e.n), [7, 8, 9]);
  });

  it('returns everything when the file holds fewer entries than asked for', async (t) => {
    const file = openJsonlFile<Entry>({ path: await fileWith(t, entries(4)) });
    assert.equal((await file.readTail(500)).length, 4);
  });

  it('agrees with readAll().slice(-n) on an ordinary file', async (t) => {
    const path = await fileWith(t, entries(50));
    const file = openJsonlFile<Entry>({ path });
    assert.deepEqual(await file.readTail(12), (await file.readAll()).slice(-12));
  });

  it('never parses the partial record a mid-file window opens on', async (t) => {
    // The failure this guards: the read window starts partway through
    // whatever line straddles the boundary, and that fragment is not JSON.
    // 4000 entries at ~30 bytes is far past the 1-entry window, so the read
    // is guaranteed to begin mid-file.
    const file = openJsonlFile<Entry>({ path: await fileWith(t, entries(4_000)) });

    const tail = await file.readTail(1);
    assert.equal(tail.length, 1);
    assert.equal(tail[0]?.n, 3_999);
  });

  it('survives a multi-byte character straddling the window boundary', async (t) => {
    // Slicing at a byte offset can land mid-UTF-8-sequence. That damage is
    // always confined to the first line, which is exactly the one dropped.
    const padded = Array.from({ length: 3_000 }, (_, i) =>
      JSON.stringify({ n: i, text: `naïve café — ${i} 🎧` }),
    );
    const file = openJsonlFile<Entry>({ path: await fileWith(t, padded) });

    const tail = await file.readTail(5);
    assert.equal(tail.length, 5);
    assert.deepEqual(tail.map((e) => e.n), [2_995, 2_996, 2_997, 2_998, 2_999]);
    assert.equal(tail[4]?.text, 'naïve café — 2999 🎧');
  });

  it('reads only a bounded window rather than the whole file', async (t) => {
    // 20k entries of ~1KB each is ~20MB on disk; a 5-entry tail must not pull
    // that in. Asserted through the injected reader, since the observable
    // effect is the size of the read, not the result.
    const path = await fileWith(t, entries(200, ' '.repeat(1_000)));
    let bytesRequested = -1;
    const file = openJsonlFile<Entry>({
      path,
      readTailBytes: async (p, maxBytes) => {
        bytesRequested = maxBytes;
        const { readFile } = await import('node:fs/promises');
        const whole = await readFile(p, 'utf8');
        const text = whole.slice(Math.max(0, whole.length - maxBytes));
        return { text, truncated: whole.length > maxBytes };
      },
    });

    await file.readTail(5);
    assert.ok(bytesRequested > 0);
    assert.ok(
      bytesRequested < 200 * 1_000,
      `asked for ${bytesRequested} bytes, which is not meaningfully bounded`,
    );
  });

  it('picks up entries appended after an earlier read, with no cache to go stale', async (t) => {
    const path = await fileWith(t, entries(3));
    const file = openJsonlFile<Entry>({ path });
    assert.equal((await file.readTail(10)).length, 3);

    await appendFile(path, `${JSON.stringify({ n: 99, text: 'later' })}\n`, 'utf8');
    const tail = await file.readTail(10);
    assert.equal(tail.length, 4);
    assert.equal(tail[3]?.n, 99);
  });
});
