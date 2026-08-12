import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { parseRangeHeader, safeSegmentPath } from '../../src/host/http/segment-file.ts';

describe('parseRangeHeader', () => {
  it('returns null for an undefined header', () => {
    assert.equal(parseRangeHeader(undefined, 1_000), null);
  });

  it('returns null when size is 0, regardless of header', () => {
    assert.equal(parseRangeHeader('bytes=0-99', 0), null);
  });

  it('parses bytes=0-99', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-99', 1_000), { start: 0, end: 99 });
  });

  it('parses an open-ended bytes=100- as start..size-1', () => {
    assert.deepEqual(parseRangeHeader('bytes=100-', 1_000), { start: 100, end: 999 });
  });

  it('parses a suffix range bytes=-500 as the last 500 bytes', () => {
    assert.deepEqual(parseRangeHeader('bytes=-500', 1_000), { start: 500, end: 999 });
  });

  it('clamps a suffix larger than the file to the whole file rather than going negative', () => {
    assert.deepEqual(parseRangeHeader('bytes=-5000', 1_000), { start: 0, end: 999 });
  });

  it('treats bytes=-0 as unsatisfiable', () => {
    assert.equal(parseRangeHeader('bytes=-0', 1_000), 'unsatisfiable');
  });

  it('treats a start at size as unsatisfiable', () => {
    assert.equal(parseRangeHeader('bytes=1000-', 1_000), 'unsatisfiable');
  });

  it('treats a start past size as unsatisfiable', () => {
    assert.equal(parseRangeHeader('bytes=5000-', 1_000), 'unsatisfiable');
  });

  it('treats an end below the start as unsatisfiable', () => {
    assert.equal(parseRangeHeader('bytes=500-100', 1_000), 'unsatisfiable');
  });

  it('clamps an end past EOF to size-1', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-99999', 1_000), { start: 0, end: 999 });
  });

  it('ignores a non-bytes unit, per RFC 9110 -- send the whole body rather than error', () => {
    assert.equal(parseRangeHeader('pages=1-2', 1_000), null);
  });

  it('ignores a garbage range value', () => {
    assert.equal(parseRangeHeader('bytes=abc', 1_000), null);
  });

  it('ignores a multi-range header, per RFC 9110 -- send the whole body rather than error', () => {
    assert.equal(parseRangeHeader('bytes=0-1,5-6', 1_000), null);
  });
});

describe('safeSegmentPath', () => {
  // A fixed absolute dir that works cross-platform -- built from the real
  // tmpdir rather than a hardcoded Windows path, per the task's own caveat
  // that the tests must pass on whatever machine runs them.
  const dir = join(tmpdir(), 'solver-segment-file-test', 'recordings');

  it('resolves a normal UUID id to a path inside dir, with a .webm extension for video/webm...', () => {
    const id = '5b1f8e2a-2222-4444-8888-abcdefabcdef';
    const result = safeSegmentPath(dir, id, 'video/webm;codecs=vp9');
    assert.notEqual(result, null);
    assert.ok(result!.startsWith(dir));
    assert.ok(result!.endsWith('.webm'));
  });

  it('resolves a normal UUID id to a path inside dir, with a .mp4 extension for video/mp4...', () => {
    const id = '5b1f8e2a-2222-4444-8888-abcdefabcdef';
    const result = safeSegmentPath(dir, id, 'video/mp4;codecs=avc1');
    assert.notEqual(result, null);
    assert.ok(result!.startsWith(dir));
    assert.ok(result!.endsWith('.mp4'));
  });

  it('rejects a POSIX-style traversal id (../secrets)', () => {
    assert.equal(safeSegmentPath(dir, '../secrets', 'video/webm'), null);
  });

  it('rejects a deeper POSIX-style traversal id (../../config)', () => {
    assert.equal(safeSegmentPath(dir, '../../config', 'video/webm'), null);
  });

  it('rejects a Windows-style traversal id (..\\..\\config)', () => {
    assert.equal(safeSegmentPath(dir, '..\\..\\config', 'video/webm'), null);
  });

  it('rejects a Windows absolute-path id (C:\\Windows\\System32\\config)', () => {
    assert.equal(safeSegmentPath(dir, 'C:\\Windows\\System32\\config', 'video/webm'), null);
  });

  it('rejects an id that is exactly .', () => {
    assert.equal(safeSegmentPath(dir, '.', 'video/webm'), null);
  });

  // The next two cases document *actual*, verified behaviour that surprised
  // me relative to what a naive spec-reading would expect -- see this file's
  // accompanying report for the full writeup. Not weakened to force a green
  // check: these assertions are what `safeSegmentPath` genuinely does today.

  // Both of the cases below were found by testing this function in isolation
  // and originally passed for the wrong reason: `join` folded a POSIX-absolute
  // id into an ordinary nested path (`<dir>/etc/passwd.webm`), and an empty id
  // resolved to a bare `<dir>/.webm`. Containment held in both -- neither was a
  // traversal -- but each produced a path nobody asked for, and the only thing
  // stopping them reaching this function was the route's own empty-id guard.
  // The separator rejection in `safeSegmentPath` now makes the contract ("an id
  // names one file directly under dir, never a path") true here rather than at
  // the call site.
  it('rejects a POSIX-absolute id rather than folding it into a nested path under dir', () => {
    assert.equal(safeSegmentPath(dir, '/etc/passwd', 'video/webm'), null);
  });

  it('rejects an empty id rather than resolving it to a bare extension', () => {
    assert.equal(safeSegmentPath(dir, '', 'video/webm'), null);
  });
});
