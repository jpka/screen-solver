import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldRollSegment } from '../../src/host/screen-recording/segment-policy.ts';
import { selectSegmentsToPrune } from '../../src/host/screen-recording/retention.ts';
import type { ScreenRecordingSegment } from '../../src/host/logs/types.ts';

describe('shouldRollSegment', () => {
  it('rolls when elapsed reaches segmentSeconds * 1000 exactly', () => {
    assert.equal(
      shouldRollSegment({ elapsedMs: 5 * 60 * 1_000, bytes: 0, segmentSeconds: 5 * 60 }),
      true,
    );
  });

  it('does not roll one millisecond below the time boundary', () => {
    assert.equal(
      shouldRollSegment({ elapsedMs: 5 * 60 * 1_000 - 1, bytes: 0, segmentSeconds: 5 * 60 }),
      false,
    );
  });

  it('rolls on the byte cap even when barely any time has passed', () => {
    assert.equal(
      shouldRollSegment({ elapsedMs: 1, bytes: 256 * 1024 * 1024, segmentSeconds: 5 * 60 }),
      true,
    );
  });

  it('does not roll when neither bound is reached', () => {
    assert.equal(
      shouldRollSegment({ elapsedMs: 1_000, bytes: 1_000, segmentSeconds: 5 * 60 }),
      false,
    );
  });

  it('honours a maxSegmentBytes override instead of the production default', () => {
    assert.equal(
      shouldRollSegment({ elapsedMs: 0, bytes: 100, segmentSeconds: 5 * 60, maxSegmentBytes: 100 }),
      true,
    );
    assert.equal(
      shouldRollSegment({ elapsedMs: 0, bytes: 99, segmentSeconds: 5 * 60, maxSegmentBytes: 100 }),
      false,
    );
  });
});

/** Builds a minimal ScreenRecordingSegment, overridable per test. */
function segment(overrides: Partial<ScreenRecordingSegment> & { readonly id: string }): ScreenRecordingSegment {
  return {
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:05:00.000Z',
    bytes: 0,
    durationMs: 5 * 60 * 1_000,
    mimeType: 'video/webm',
    target: null,
    ...overrides,
  };
}

describe('selectSegmentsToPrune', () => {
  const NOW = new Date('2026-08-12T00:00:00.000Z');

  it('returns empty for empty input', () => {
    assert.deepEqual(
      selectSegmentsToPrune({ segments: [], retentionBytes: 1_000, retentionDays: 30, now: NOW }),
      [],
    );
  });

  it('returns ids oldest first, in exact order', () => {
    const segments = [
      segment({ id: 'c', startedAt: '2026-08-01T00:00:00.000Z', endedAt: '2026-08-01T00:01:00.000Z', bytes: 10 }),
      segment({ id: 'a', startedAt: '2026-07-01T00:00:00.000Z', endedAt: '2026-07-01T00:01:00.000Z', bytes: 10 }),
      segment({ id: 'b', startedAt: '2026-07-15T00:00:00.000Z', endedAt: '2026-07-15T00:01:00.000Z', bytes: 10 }),
    ];
    // Small budget so the byte rule selects everything but the newest --
    // exercises ordering, not just membership.
    const result = selectSegmentsToPrune({ segments, retentionBytes: 5, retentionDays: 0, now: NOW });
    assert.deepEqual(result, ['a', 'b', 'c']);
  });

  it('age rule: prunes segments whose endedAt is older than retentionDays, keeps newer ones', () => {
    const old = segment({
      id: 'old',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:05:00.000Z',
      bytes: 10,
    });
    const recent = segment({
      id: 'recent',
      startedAt: '2026-08-10T00:00:00.000Z',
      endedAt: '2026-08-10T00:05:00.000Z',
      bytes: 10,
    });
    const result = selectSegmentsToPrune({
      segments: [old, recent],
      retentionBytes: 1_000_000,
      retentionDays: 30,
      now: NOW,
    });
    assert.deepEqual(result, ['old']);
  });

  it('age rule falls back to startedAt when endedAt is null', () => {
    const stillOpenButOld = segment({
      id: 'open-old',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      bytes: 10,
    });
    const result = selectSegmentsToPrune({
      segments: [stillOpenButOld],
      retentionBytes: 1_000_000,
      retentionDays: 30,
      now: NOW,
      // Not the open segment being written right now -- some other id, so
      // the age rule alone is what's under test here.
      openSegmentId: 'someone-else',
    });
    assert.deepEqual(result, ['open-old']);
  });

  it('byte rule: keeps the newest segments until the budget is exhausted, prunes the rest', () => {
    const s1 = segment({ id: 's1', startedAt: '2026-08-01T00:00:00.000Z', endedAt: '2026-08-01T00:01:00.000Z', bytes: 100 });
    const s2 = segment({ id: 's2', startedAt: '2026-08-02T00:00:00.000Z', endedAt: '2026-08-02T00:01:00.000Z', bytes: 100 });
    const s3 = segment({ id: 's3', startedAt: '2026-08-03T00:00:00.000Z', endedAt: '2026-08-03T00:01:00.000Z', bytes: 100 });
    // Budget fits exactly the newest two (100 + 100 = 200 <= 200); the oldest
    // is pruned.
    const result = selectSegmentsToPrune({
      segments: [s1, s2, s3],
      retentionBytes: 200,
      retentionDays: 0,
      now: NOW,
    });
    assert.deepEqual(result, ['s1']);
  });

  it('openSegmentId is never selected, even when it alone blows the byte budget', () => {
    const open = segment({ id: 'open', startedAt: '2026-08-11T00:00:00.000Z', endedAt: null, bytes: 1_000_000 });
    const result = selectSegmentsToPrune({
      segments: [open],
      retentionBytes: 1,
      retentionDays: 0,
      now: NOW,
      openSegmentId: 'open',
    });
    assert.deepEqual(result, []);
  });

  it('openSegmentId is never selected, even when it alone is older than the age window', () => {
    const open = segment({
      id: 'open',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      bytes: 10,
    });
    const result = selectSegmentsToPrune({
      segments: [open],
      retentionBytes: 1_000_000,
      retentionDays: 30,
      now: NOW,
      openSegmentId: 'open',
    });
    assert.deepEqual(result, []);
  });

  it('retentionDays: 0 disables the age rule entirely, not prunes everything', () => {
    const ancient = segment({
      id: 'ancient',
      startedAt: '2020-01-01T00:00:00.000Z',
      endedAt: '2020-01-01T00:05:00.000Z',
      bytes: 10,
    });
    const result = selectSegmentsToPrune({
      segments: [ancient],
      retentionBytes: 1_000_000,
      retentionDays: 0,
      now: NOW,
    });
    assert.deepEqual(result, []);
  });

  it('both rules together do not double-count: an age-selected segment is not counted toward the retained byte total', () => {
    // If the age-doomed segment's bytes were still counted toward `retained`,
    // it would push the byte walk into pruning the newer segment too -- the
    // implementation's `if (doomed.has(segment.id)) continue;` is what this
    // guards against.
    const agedOut = segment({
      id: 'aged-out',
      startedAt: '2020-01-01T00:00:00.000Z',
      endedAt: '2020-01-01T00:05:00.000Z',
      bytes: 1_000,
    });
    const keep = segment({
      id: 'keep',
      startedAt: '2026-08-01T00:00:00.000Z',
      endedAt: '2026-08-01T00:05:00.000Z',
      bytes: 50,
    });
    const result = selectSegmentsToPrune({
      segments: [agedOut, keep],
      retentionBytes: 100,
      retentionDays: 30,
      now: NOW,
    });
    assert.deepEqual(result, ['aged-out']);
  });
});
