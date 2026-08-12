import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import type { TargetWindowIdentity } from '../../src/host/config/types.ts';
import { createScreenRecordingLog, RECORDINGS_DIR_NAME } from '../../src/host/logs/screen-recording-log.ts';
import {
  createScreenRecordingCoordinator,
  type ScreenRecordingCoordinator,
  type ScreenRecordingSnapshot,
} from '../../src/host/screen-recording/coordinator.ts';
import { createSegmentWriter } from '../../src/host/screen-recording/segment-writer.ts';
import type { OpenRecorder, Recorder, VideoChunk } from '../../src/host/screen-recording/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

const KATA_TAB: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };

/**
 * A stand-in for the hidden renderer's `MediaRecorder`.
 *
 * The only fake in this file. Everything below it -- the segment writer, the
 * JSONL index, the files themselves -- is the real implementation running
 * against a temp state root, because the interesting failures in this subsystem
 * live in the seams between those pieces (does the roll's final chunk get
 * counted before the new segment opens? does a `closed` line actually reach
 * disk?) and a faked writer would assert those seams away.
 *
 * The renderer half itself -- `getUserMedia`, `MediaRecorder`, the WGC pipeline
 * -- stays manual/E2E-verified, per this repo's standing policy for anything
 * needing a real composited desktop.
 */
function fakeRenderer() {
  let sink: ((chunk: VideoChunk) => void) | null = null;
  let onFailure: ((failure: { reason: string }) => void) | null = null;
  let currentId: string | null = null;
  let closed = false;
  const opens: string[] = [];

  const open: OpenRecorder = async (options) => {
    sink = options.sink;
    onFailure = options.onFailure;
    currentId = options.segmentId;
    closed = false;
    opens.push(options.segmentId);

    const recorder: Recorder = {
      mimeType: 'video/webm;codecs=vp9',
      async roll(next: string): Promise<void> {
        // Mirrors the real renderer's ordering: the outgoing segment's final
        // chunk is sent *before* the roll is acknowledged, which is what makes
        // `Recorder.roll()`'s "resolves once the final chunk has been handed to
        // the sink" contract true.
        sink?.({ segmentId: currentId!, bytes: new Uint8Array([0xff]), last: true });
        currentId = next;
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        sink?.({ segmentId: currentId!, bytes: new Uint8Array([0xee]), last: true });
      },
    };
    return recorder;
  };

  return {
    open,
    opens,
    /** One `dataavailable` tick of `size` bytes on the currently-open segment. */
    emit(size: number): void {
      sink?.({ segmentId: currentId!, bytes: new Uint8Array(size), last: false });
    },
    /** The out-of-band mid-session failure channel. */
    fail(reason: string): void {
      onFailure?.({ reason });
    },
  };
}

interface Harness {
  readonly coordinator: ScreenRecordingCoordinator;
  readonly renderer: ReturnType<typeof fakeRenderer>;
  readonly states: ScreenRecordingSnapshot[];
  readonly stateRoot: string;
  readonly recordingsDir: string;
  /** Moves the injected clock forward. Nothing here waits on real time. */
  advance(ms: number): void;
  readIndex(): ReturnType<ReturnType<typeof createScreenRecordingLog>['readIndex']>;
}

async function harness(
  t: TestContext,
  options: {
    readonly enabled?: boolean;
    readonly segmentSeconds?: number;
    readonly retentionBytes?: number;
    readonly retentionDays?: number;
    readonly withRecorder?: boolean;
    readonly maxSegmentBytes?: number;
  } = {},
): Promise<Harness> {
  const stateRoot = await tempStateRoot(t);
  const recordingsDir = join(stateRoot, RECORDINGS_DIR_NAME);
  const screenRecordingLog = createScreenRecordingLog({ stateRoot });
  const renderer = fakeRenderer();
  const states: ScreenRecordingSnapshot[] = [];

  let clock = Date.parse('2026-08-12T09:00:00.000Z');
  let nextId = 0;

  let coordinator: ScreenRecordingCoordinator;
  const writer = createSegmentWriter({
    dir: recordingsDir,
    screenRecordingLog,
    onError: (reason) => coordinator.fail(reason),
    now: () => new Date(clock),
  });

  coordinator = createScreenRecordingCoordinator({
    writer,
    screenRecordingLog,
    openRecorder: options.withRecorder === false ? undefined : renderer.open,
    settings: () => ({
      enabled: options.enabled ?? false,
      segmentSeconds: options.segmentSeconds ?? 300,
      retentionBytes: options.retentionBytes ?? 2 * 1024 * 1024 * 1024,
      retentionDays: options.retentionDays ?? 7,
    }),
    currentTarget: () => KATA_TAB,
    now: () => new Date(clock),
    newSegmentId: () => `seg-${(nextId += 1)}`,
    maxSegmentBytes: options.maxSegmentBytes,
  });

  coordinator.onStateChange((snapshot) => states.push(snapshot));
  t.after(() => coordinator.stop());

  return {
    coordinator,
    renderer,
    states,
    stateRoot,
    recordingsDir,
    advance: (ms) => {
      clock += ms;
    },
    readIndex: () => screenRecordingLog.readIndex(),
  };
}

describe('ScreenRecordingCoordinator', () => {
  it('is unavailable, and stays off, when no recorder opener was wired', async (t) => {
    const { coordinator } = await harness(t, { withRecorder: false });

    assert.equal(coordinator.snapshot().state, 'unavailable');
    const after = await coordinator.start();
    assert.equal(after.state, 'unavailable');
  });

  it('opens a segment on start and writes its chunks to disk as they arrive', async (t) => {
    const h = await harness(t);

    await h.coordinator.start();
    assert.equal(h.coordinator.snapshot().state, 'recording');
    assert.equal(h.coordinator.snapshot().segmentId, 'seg-1');

    h.renderer.emit(1_000);
    h.renderer.emit(500);
    await h.coordinator.drain();

    // The crash-safety property, asserted directly: the bytes are on disk
    // *while* the recording is still going, not only once it stops.
    const bytes = await readFile(join(h.recordingsDir, 'seg-1.webm'));
    assert.equal(bytes.byteLength, 1_500);
    assert.equal(h.coordinator.snapshot().state, 'recording');
  });

  it("writes the segment's index line before any of its bytes exist, so a crashed segment is still listed", async (t) => {
    const h = await harness(t);

    await h.coordinator.start();
    // Nothing emitted yet, nothing drained -- and the index already knows.
    const index = await h.readIndex();
    assert.equal(index.length, 1);
    assert.equal(index[0]?.id, 'seg-1');
    assert.equal(index[0]?.endedAt, null);
    assert.equal(index[0]?.mimeType, 'video/webm;codecs=vp9');
    assert.deepEqual(index[0]?.target, KATA_TAB);
  });

  it('is idempotent while already recording', async (t) => {
    const h = await harness(t);

    await h.coordinator.start();
    await h.coordinator.start();

    assert.deepEqual(h.renderer.opens, ['seg-1']);
    assert.equal(h.coordinator.snapshot().segmentId, 'seg-1');
  });

  it('rolls to a fresh segment once the configured duration elapses, closing out the old one', async (t) => {
    const h = await harness(t, { segmentSeconds: 60 });

    await h.coordinator.start();
    h.renderer.emit(2_000);

    h.advance(30_000);
    await h.coordinator.tick();
    assert.equal(h.coordinator.snapshot().segmentId, 'seg-1', 'not yet at the boundary');

    h.advance(30_000);
    await h.coordinator.tick();
    await h.coordinator.drain();

    assert.equal(h.coordinator.snapshot().segmentId, 'seg-2');
    assert.equal(h.coordinator.snapshot().state, 'recording');

    const index = await h.readIndex();
    const first = index.find((segment) => segment.id === 'seg-1');
    const second = index.find((segment) => segment.id === 'seg-2');

    // The outgoing segment is complete: closed, with its final chunk counted.
    assert.notEqual(first?.endedAt, null);
    assert.equal(first?.bytes, 2_001, 'the 2000-byte tick plus the 1-byte final flush');
    assert.equal(first?.durationMs, 60_000);
    // And the incoming one is open, so the two never overlap.
    assert.equal(second?.endedAt, null);
  });

  it('rolls on the byte cap even when almost no time has passed', async (t) => {
    // A real 256 MiB segment is not something to write in a unit test, and
    // emitting it as one synchronous chunk would trip the writer's *queue*
    // bound long before the segment bound -- the two measure different things
    // (see `maxSegmentBytes`'s doc comment). A small injected cap reaches the
    // branch honestly.
    const h = await harness(t, { segmentSeconds: 3_600, maxSegmentBytes: 4_096 });

    await h.coordinator.start();
    h.renderer.emit(5_000);
    h.advance(1_000);
    await h.coordinator.tick();
    await h.coordinator.drain();

    assert.equal(h.coordinator.snapshot().segmentId, 'seg-2');
    assert.equal(h.coordinator.snapshot().state, 'recording');
  });

  it('stops and reports an error when the disk falls far enough behind to threaten memory', async (t) => {
    const h = await harness(t);

    await h.coordinator.start();
    // One synchronous burst past the queue bound, with nothing draining it --
    // the shape a stalled disk produces. The recorder must refuse rather than
    // grow until the process dies.
    h.renderer.emit(65 * 1024 * 1024);

    const snapshot = h.coordinator.snapshot();
    assert.equal(snapshot.state, 'error');
    assert.match(snapshot.reason ?? '', /not keeping up/);
  });

  it('flushes the final chunk and returns to off on stop', async (t) => {
    const h = await harness(t);

    await h.coordinator.start();
    h.renderer.emit(4_000);
    await h.coordinator.stop();
    await h.coordinator.drain();

    assert.equal(h.coordinator.snapshot().state, 'off');
    assert.equal(h.coordinator.snapshot().segmentId, null);

    const index = await h.readIndex();
    assert.equal(index[0]?.bytes, 4_001, 'the tick plus the close flush');
    assert.notEqual(index[0]?.endedAt, null);
  });

  it('goes to error when the renderer reports a mid-session failure', async (t) => {
    const h = await harness(t);

    await h.coordinator.start();
    h.renderer.fail('the MediaRecorder errored');

    const snapshot = h.coordinator.snapshot();
    assert.equal(snapshot.state, 'error');
    assert.equal(snapshot.reason, 'the MediaRecorder errored');
  });

  it('ignores the renderer failure that a deliberate stop provokes, rather than latching error', async (t) => {
    const h = await harness(t);
    await h.coordinator.start();

    // The real renderer reports "capture stream stopped underneath the active
    // recording" whenever tracks are torn down while a recorder is live --
    // including during a stop we asked for. That must not strand the user in
    // `error` after an ordinary stop.
    const stopping = h.coordinator.stop();
    h.renderer.fail('capture stream stopped underneath the active recording');
    await stopping;

    assert.equal(h.coordinator.snapshot().state, 'off');
    assert.equal(h.coordinator.snapshot().reason, null);
  });

  it('clears a standing error on the next deliberate stop, so a fresh start is possible', async (t) => {
    const h = await harness(t);

    await h.coordinator.start();
    h.renderer.fail('disk went away');
    assert.equal(h.coordinator.snapshot().state, 'error');

    await h.coordinator.stop();
    assert.equal(h.coordinator.snapshot().state, 'off');

    await h.coordinator.start();
    assert.equal(h.coordinator.snapshot().state, 'recording');
  });

  describe('following the capture session', () => {
    it('stops when the capture stream goes away', async (t) => {
      const h = await harness(t, { enabled: true });

      await h.coordinator.start();
      await h.coordinator.onCaptureSessionChange(null);

      assert.equal(h.coordinator.snapshot().state, 'off');
      // Called *before* the stream actually closes, so the flush landed.
      await h.coordinator.drain();
      const index = await h.readIndex();
      assert.notEqual(index[0]?.endedAt, null, 'the segment was closed out cleanly, not left dangling');
    });

    it('starts automatically on a fresh stream when enabled', async (t) => {
      const h = await harness(t, { enabled: true });

      await h.coordinator.onCaptureSessionChange(KATA_TAB);

      assert.equal(h.coordinator.snapshot().state, 'recording');
    });

    it('does not start itself on a fresh stream when disabled', async (t) => {
      const h = await harness(t, { enabled: false });

      await h.coordinator.onCaptureSessionChange(KATA_TAB);

      assert.equal(h.coordinator.snapshot().state, 'off');
      assert.deepEqual(h.renderer.opens, []);
    });

    it('restarts into a new segment when the target changes, so one segment is never two windows', async (t) => {
      const h = await harness(t, { enabled: true });

      await h.coordinator.start();
      h.renderer.emit(1_000);
      await h.coordinator.onCaptureSessionChange(null);
      await h.coordinator.onCaptureSessionChange(KATA_TAB);
      await h.coordinator.drain();

      assert.deepEqual(h.renderer.opens, ['seg-1', 'seg-2']);
      const index = await h.readIndex();
      assert.equal(index.length, 2);
      assert.notEqual(
        index.find((segment) => segment.id === 'seg-1')?.endedAt,
        null,
        'the pre-change segment is complete',
      );
    });
  });

  describe('retention', () => {
    it('prunes the oldest segments past the byte budget, and never the open one', async (t) => {
      const h = await harness(t, { segmentSeconds: 60, retentionBytes: 5_000 });

      await h.coordinator.start();
      // Three complete segments of ~3000 bytes each, then a fourth left open.
      for (let i = 0; i < 3; i += 1) {
        h.renderer.emit(3_000);
        h.advance(60_000);
        await h.coordinator.tick();
        await h.coordinator.drain();
      }

      const index = await h.readIndex();
      const ids = index.map((segment) => segment.id).sort();
      // seg-1 and seg-2 are past the 5000-byte budget; seg-3 fits; seg-4 is
      // open and exempt regardless.
      assert.deepEqual(ids, ['seg-3', 'seg-4']);

      await assert.rejects(readFile(join(h.recordingsDir, 'seg-1.webm')), 'the file itself is gone');
    });

    it('leaves everything alone when the budget is generous', async (t) => {
      const h = await harness(t, { segmentSeconds: 60, retentionBytes: 1_000_000 });

      await h.coordinator.start();
      h.renderer.emit(3_000);
      h.advance(60_000);
      await h.coordinator.tick();
      await h.coordinator.drain();

      assert.equal((await h.readIndex()).length, 2);
    });
  });

  describe('reconcile', () => {
    it('closes out a segment left open by an unclean exit, measuring the file that survived', async (t) => {
      const h = await harness(t);

      // Exactly the on-disk state a `kill -9` mid-segment leaves behind: an
      // `opened` line, real bytes, and no `closed` line.
      await h.coordinator.start();
      h.renderer.emit(7_000);
      await h.coordinator.drain();

      const revived = await harness(t, {});
      await writeFile(join(revived.recordingsDir, 'seg-1.webm'), Buffer.alloc(7_000)).catch(
        () => {},
      );

      await h.coordinator.reconcile();

      const index = await h.readIndex();
      const segment = index.find((candidate) => candidate.id === 'seg-1');
      assert.notEqual(segment?.endedAt, null, 'it was closed out');
      assert.equal(segment?.bytes, 7_000, 'measured from the file, not guessed');
      assert.equal(segment?.recovered, true, '"the process died" stays distinguishable from "the user stopped"');
    });

    it('tombstones an indexed segment whose file no longer exists', async (t) => {
      const h = await harness(t);

      await h.coordinator.start();
      await h.coordinator.drain();
      // The `opened` line outlived its file -- a hand-deleted recording.
      await h.coordinator.stop();
      await h.coordinator.drain();
      const { unlink } = await import('node:fs/promises');
      await unlink(join(h.recordingsDir, 'seg-1.webm'));

      // Re-open the segment's index state by appending a fresh `opened` with no
      // file behind it at all.
      const log = createScreenRecordingLog({ stateRoot: h.stateRoot });
      await log.append({
        type: 'opened',
        id: 'ghost',
        startedAt: '2026-08-12T08:00:00.000Z',
        mimeType: 'video/webm',
        target: null,
      });

      await h.coordinator.reconcile();

      const index = await h.readIndex();
      assert.equal(
        index.some((segment) => segment.id === 'ghost'),
        false,
        'the index stops advertising a recording that cannot be played',
      );
    });
  });

  it('publishes a snapshot on every state change, for the SSE wire', async (t) => {
    const h = await harness(t);

    await h.coordinator.start();
    await h.coordinator.stop();

    const states = h.states.map((snapshot) => snapshot.state);
    assert.deepEqual(states.slice(0, 3), ['starting', 'recording', 'off']);
  });
});
