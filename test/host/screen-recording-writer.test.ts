import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createScreenRecordingLog } from '../../src/host/logs/screen-recording-log.ts';
import {
  createSegmentWriter,
  MAX_QUEUED_BYTES,
  type SegmentWriter,
} from '../../src/host/screen-recording/segment-writer.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * `segment-writer.ts`'s session fencing and queue bound, tested directly
 * against the writer rather than through the coordinator.
 *
 * These cases are all about *when* a failure is allowed to reach `onError`,
 * which needs a write that fails on demand -- easy with an injected
 * `appendFile`, and impossible to arrange reliably against a real disk.
 */

interface Harness {
  readonly writer: SegmentWriter;
  readonly errors: string[];
  /** Resolves the pending write for `path` with a rejection. */
  failPending(path: string): void;
  /** Resolves the pending write for `path` successfully. */
  settlePending(path: string): void;
}

async function harness(t: TestContext): Promise<Harness> {
  const stateRoot = await tempStateRoot(t);
  const errors: string[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  const writer = createSegmentWriter({
    dir: join(stateRoot, 'recordings'),
    screenRecordingLog: createScreenRecordingLog({ stateRoot }),
    onError: (reason) => errors.push(reason),
    // Held open until the test decides the outcome, which is what lets a write
    // still be in flight while a later session starts.
    appendFile: (path) =>
      new Promise<void>((resolve, reject) => {
        pending.set(path, { resolve, reject });
      }),
  });

  return {
    writer,
    errors,
    failPending(path) {
      pending.get(path)?.reject(new Error('ENOSPC'));
      pending.delete(path);
    },
    settlePending(path) {
      pending.get(path)?.resolve();
      pending.delete(path);
    },
  };
}

/** Lets the writer's internal promise chain advance. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('SegmentWriter session fencing', () => {
  it('reports a write failure from the current session', async (t) => {
    const h = await harness(t);
    h.writer.startSession();
    await h.writer.begin('seg-1', 'video/webm', null);

    h.writer.write({ segmentId: 'seg-1', bytes: new Uint8Array(10), last: false });
    await settle();
    h.failPending(h.writer.pathFor('seg-1', 'video/webm'));
    await settle();

    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0]!, /Failed writing/);
  });

  it('does not let a finished session\'s failed write tear down the recording that replaced it', async (t) => {
    const h = await harness(t);

    // Session one writes a chunk that is still in flight when the session ends.
    // `stop()` does not drain the chain (only a roll and shutdown do), so this
    // is the ordinary shape of a stop, not a contrived one -- and after an
    // overflow it is the likely one, since a disk that fell behind is exactly
    // the disk whose queued writes then fail.
    h.writer.startSession();
    await h.writer.begin('seg-1', 'video/webm', null);
    h.writer.write({ segmentId: 'seg-1', bytes: new Uint8Array(10), last: false });
    await settle();

    // Session two starts while that write is still outstanding.
    h.writer.startSession();
    await h.writer.begin('seg-2', 'video/webm', null);

    // Now the old write fails.
    h.failPending(h.writer.pathFor('seg-1', 'video/webm'));
    await settle();

    assert.deepEqual(h.errors, [], 'the new recording is left alone');
  });

  it('still reports a current-session failure after an earlier session was fenced off', async (t) => {
    const h = await harness(t);
    h.writer.startSession();
    await h.writer.begin('seg-1', 'video/webm', null);
    h.writer.write({ segmentId: 'seg-1', bytes: new Uint8Array(10), last: false });
    await settle();

    h.writer.startSession();
    await h.writer.begin('seg-2', 'video/webm', null);
    h.failPending(h.writer.pathFor('seg-1', 'video/webm'));
    await settle();

    // The fence must not have made the writer permanently quiet.
    h.writer.write({ segmentId: 'seg-2', bytes: new Uint8Array(10), last: false });
    await settle();
    h.failPending(h.writer.pathFor('seg-2', 'video/webm'));
    await settle();

    assert.equal(h.errors.length, 1);
  });

  it('reports an overflow once, then accepts writes again in the next session', async (t) => {
    const h = await harness(t);
    h.writer.startSession();
    await h.writer.begin('seg-1', 'video/webm', null);

    h.writer.write({ segmentId: 'seg-1', bytes: new Uint8Array(MAX_QUEUED_BYTES + 1), last: false });
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0]!, /not keeping up/);

    // Every further chunk of the doomed session is dropped rather than queued.
    h.writer.write({ segmentId: 'seg-1', bytes: new Uint8Array(10), last: false });
    assert.equal(h.errors.length, 1, 'not re-reported per chunk');

    h.writer.startSession();
    await h.writer.begin('seg-2', 'video/webm', null);
    h.writer.write({ segmentId: 'seg-2', bytes: new Uint8Array(10), last: false });
    await settle();
    h.settlePending(h.writer.pathFor('seg-2', 'video/webm'));
    await settle();

    assert.equal(h.errors.length, 1, 'the retry writes normally');
    assert.equal(h.writer.bytesFor('seg-2'), 10);
  });

  it('does not count the chunk that tripped the bound against the backlog', async (t) => {
    const h = await harness(t);
    h.writer.startSession();
    await h.writer.begin('seg-1', 'video/webm', null);

    // The oversized chunk is refused outright, so nothing it contained was ever
    // enqueued and nothing can decrement it later. Counting it would leave the
    // writer permanently believing it had a backlog it does not have, which is
    // how the *next* session would then trip the bound early.
    h.writer.write({ segmentId: 'seg-1', bytes: new Uint8Array(MAX_QUEUED_BYTES + 1), last: false });
    assert.equal(h.writer.bytesFor('seg-1'), 0);

    h.writer.startSession();
    await h.writer.begin('seg-2', 'video/webm', null);
    // A chunk that only fits if the refused one was never counted.
    h.writer.write({ segmentId: 'seg-2', bytes: new Uint8Array(MAX_QUEUED_BYTES - 1), last: false });

    assert.deepEqual(h.errors.slice(1), [], 'no spurious second overflow');
    assert.equal(h.writer.bytesFor('seg-2'), MAX_QUEUED_BYTES - 1);
  });
});
