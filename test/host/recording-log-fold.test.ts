import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldRecordingLog } from '../../src/host/logs/recording-log.ts';
import type { RecordingLogEntry } from '../../src/host/logs/types.ts';

describe('foldRecordingLog', () => {
  it('returns empty for empty input', () => {
    assert.deepEqual(foldRecordingLog([]), []);
  });

  it('an opened with no closed folds to a segment with endedAt: null, bytes: 0, durationMs: null', () => {
    const entries: RecordingLogEntry[] = [
      { type: 'opened', id: 'a', startedAt: '2026-08-01T00:00:00.000Z', mimeType: 'video/webm', target: null },
    ];
    const result = foldRecordingLog(entries);
    assert.deepEqual(result, [
      {
        id: 'a',
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: null,
        bytes: 0,
        durationMs: null,
        mimeType: 'video/webm',
        target: null,
      },
    ]);
  });

  it('opened + closed folds to a complete segment with a computed durationMs', () => {
    const entries: RecordingLogEntry[] = [
      { type: 'opened', id: 'a', startedAt: '2026-08-01T00:00:00.000Z', mimeType: 'video/webm', target: null },
      { type: 'closed', id: 'a', endedAt: '2026-08-01T00:05:00.000Z', bytes: 12_345 },
    ];
    const result = foldRecordingLog(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.endedAt, '2026-08-01T00:05:00.000Z');
    assert.equal(result[0]?.bytes, 12_345);
    assert.equal(result[0]?.durationMs, 5 * 60 * 1_000);
  });

  it('a pruned entry removes the segment entirely from the output', () => {
    const entries: RecordingLogEntry[] = [
      { type: 'opened', id: 'a', startedAt: '2026-08-01T00:00:00.000Z', mimeType: 'video/webm', target: null },
      { type: 'closed', id: 'a', endedAt: '2026-08-01T00:05:00.000Z', bytes: 100 },
      { type: 'pruned', id: 'a', prunedAt: '2026-08-02T00:00:00.000Z' },
    ];
    assert.deepEqual(foldRecordingLog(entries), []);
  });

  it('a closed for an id that was never opened is ignored rather than throwing', () => {
    const entries: RecordingLogEntry[] = [
      { type: 'closed', id: 'ghost', endedAt: '2026-08-01T00:05:00.000Z', bytes: 100 },
    ];
    assert.doesNotThrow(() => foldRecordingLog(entries));
    assert.deepEqual(foldRecordingLog(entries), []);
  });

  it('a pruned for an id that was never opened is ignored rather than throwing', () => {
    const entries: RecordingLogEntry[] = [{ type: 'pruned', id: 'ghost', prunedAt: '2026-08-01T00:05:00.000Z' }];
    assert.doesNotThrow(() => foldRecordingLog(entries));
    assert.deepEqual(foldRecordingLog(entries), []);
  });

  it('recovered: true is carried through from a closed entry, and absent otherwise', () => {
    const entries: RecordingLogEntry[] = [
      { type: 'opened', id: 'a', startedAt: '2026-08-01T00:00:00.000Z', mimeType: 'video/webm', target: null },
      { type: 'closed', id: 'a', endedAt: '2026-08-01T00:05:00.000Z', bytes: 100, recovered: true },
      { type: 'opened', id: 'b', startedAt: '2026-08-01T01:00:00.000Z', mimeType: 'video/webm', target: null },
      { type: 'closed', id: 'b', endedAt: '2026-08-01T01:05:00.000Z', bytes: 100 },
    ];
    const result = foldRecordingLog(entries);
    const a = result.find((s) => s.id === 'a');
    const b = result.find((s) => s.id === 'b');
    assert.equal(a?.recovered, true);
    assert.equal(b?.recovered, undefined);
    assert.ok(!('recovered' in (b as object)) || b?.recovered === undefined);
  });

  it('output is sorted newest first by startedAt, even when appended in a different order', () => {
    const entries: RecordingLogEntry[] = [
      { type: 'opened', id: 'middle', startedAt: '2026-08-02T00:00:00.000Z', mimeType: 'video/webm', target: null },
      { type: 'opened', id: 'oldest', startedAt: '2026-08-01T00:00:00.000Z', mimeType: 'video/webm', target: null },
      { type: 'opened', id: 'newest', startedAt: '2026-08-03T00:00:00.000Z', mimeType: 'video/webm', target: null },
    ];
    const result = foldRecordingLog(entries);
    assert.deepEqual(
      result.map((s) => s.id),
      ['newest', 'middle', 'oldest'],
    );
  });

  it('an unparseable endedAt yields durationMs: null rather than NaN', () => {
    const entries: RecordingLogEntry[] = [
      { type: 'opened', id: 'a', startedAt: '2026-08-01T00:00:00.000Z', mimeType: 'video/webm', target: null },
      { type: 'closed', id: 'a', endedAt: 'not-a-date', bytes: 100 },
    ];
    const result = foldRecordingLog(entries);
    assert.equal(result[0]?.durationMs, null);
    assert.ok(!Number.isNaN(result[0]?.durationMs));
  });
});
