import { appendFile as appendFileFs, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { silentLogger, type Logger } from '../logger.ts';
import type { ScreenRecordingLog } from '../logs/screen-recording-log.ts';
import type { TargetWindowIdentity } from '../config/types.ts';
import type { SegmentId, VideoChunk } from './types.ts';

/**
 * Chunks in, files and index lines out (#47).
 *
 * Two properties this exists to guarantee, both of which are the difference
 * between a recorder that survives a week of uptime and one that doesn't:
 *
 * **Crash safety.** Every chunk is appended the moment it arrives, never
 * accumulated in memory and written at `stop()`. A `kill -9` therefore loses at
 * most the timeslice currently being assembled in the renderer, and the file
 * already on disk stays playable up to that point. The naive shape (collect
 * blobs, `new Blob(parts)` at the end) loses the entire recording to the same
 * kill, which for a "leave it running all day" feature is the whole ballgame.
 * `appendFile` per chunk rather than one long-lived `FileHandle` reinforces
 * this: each call opens, writes, and closes, so nothing sits in a handle whose
 * buffers a crash would discard.
 *
 * **Bounded memory.** Writes are serialized through a promise chain, the same
 * shape and for the same reason as `logs/recorder.ts` -- concurrent
 * `fs.appendFile` calls race on disk-completion order rather than call order,
 * and for a video segment that means interleaved, corrupt output rather than
 * merely out-of-order lines. But unlike `logs/recorder.ts`, this chain must be
 * *bounded*. Solve outcomes arrive at human pace; video arrives on the device's
 * clock whether or not the disk keeps up. An unbounded chain in front of a slow
 * or stalled disk is an out-of-memory crash with extra steps, so
 * {@link MAX_QUEUED_BYTES} is the point at which this stops recording and says
 * so, instead of growing until the process dies.
 */

/**
 * How many bytes may sit in the write chain before recording is abandoned.
 *
 * Generous enough that an ordinary I/O hiccup -- a spinning disk seeking, a
 * virus scanner briefly holding the file, a laptop waking up -- is absorbed
 * rather than treated as failure, and small enough that a genuinely stalled
 * disk is caught in seconds rather than after the process has ballooned. At
 * typical window-capture bitrates this is on the order of a minute of backlog.
 */
export const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export interface SegmentWriterDeps {
  /** `<stateRoot>/recordings`. Created on first use. */
  readonly dir: string;
  readonly screenRecordingLog: ScreenRecordingLog;
  /**
   * Called when a write fails, or when the queue overflows. The coordinator
   * turns this into the `error` state; nothing recovers in place, because a
   * recorder that kept running against a disk it can't write to is lying.
   */
  readonly onError: (reason: string) => void;
  readonly logger?: Logger;
  /** Injected for tests; production appends real bytes. */
  readonly appendFile?: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Injected for tests; production unlinks the real file. */
  readonly removeFile?: (path: string) => Promise<void>;
  /** Injected for tests; production uses the real clock. */
  readonly now?: () => Date;
}

export interface SegmentWriter {
  /**
   * Opens a new recording session, clearing any latched overflow and fencing
   * off everything queued by the previous one.
   *
   * This writer outlives every session -- `bootstrap.ts` builds exactly one per
   * process -- while `onError` tears down whichever recording is live *now*.
   * Those two facts together mean an unfenced failure from an old session's
   * still-draining write kills the new recording that replaced it (review), and
   * that is not a hypothetical pairing: an overflow means the disk is already
   * struggling, so the writes left queued behind it are exactly the ones most
   * likely to fail, and `stop()` doesn't drain them (only a roll and shutdown
   * do). Called once per `start()`, never on a roll -- within one session a
   * failed write for an earlier segment is still this session's problem.
   */
  startSession(): void;
  /** Appends the `opened` index line and starts accepting chunks for `id`. */
  begin(id: SegmentId, mimeType: string, target: TargetWindowIdentity | null): Promise<void>;
  /**
   * Enqueues one chunk. Deliberately synchronous and non-blocking: the caller
   * is an IPC listener with nowhere to put backpressure, so the queue bound
   * above is the only honest place to refuse work.
   */
  write(chunk: VideoChunk): void;
  /** Bytes enqueued for `id` so far -- what `segment-policy.ts` weighs for a size roll. */
  bytesFor(id: SegmentId): number;
  /** Absolute path of a segment's file, for the playback route. */
  pathFor(id: SegmentId, mimeType: string): string;
  /** Deletes one segment's file and appends its `pruned` tombstone. */
  prune(id: SegmentId, mimeType: string): Promise<void>;
  /** Resolves once every write enqueued so far has landed. `logs/recorder.ts`'s `drain()`, same contract. */
  drain(): Promise<void>;
}

export function createSegmentWriter(deps: SegmentWriterDeps): SegmentWriter {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const appendFile =
    deps.appendFile ?? ((path: string, bytes: Uint8Array) => appendFileFs(path, bytes));
  const removeFile = deps.removeFile ?? ((path: string) => unlink(path));

  let chain: Promise<void> = Promise.resolve();
  let queuedBytes = 0;
  let overflowed = false;
  /** Bumped per recording session; every queued write remembers the one it belongs to. */
  let session = 0;
  /** Per-segment byte totals and mime types, dropped once a segment is closed out. */
  const open = new Map<SegmentId, { bytes: number; mimeType: string; startedAt: string }>();

  function enqueue(work: () => Promise<void>): void {
    const next = chain.then(work);
    // However this write turns out, the next queued one must still run --
    // exactly `logs/recorder.ts`'s reasoning for swallowing here.
    chain = next.catch(() => {});
  }

  return {
    startSession(): void {
      session += 1;
      // Clears a previous overflow. A latched `overflowed` used to mean that
      // after the disk fell behind once, *every* later recording silently
      // discarded every chunk while the UI cheerfully reported `recording`
      // (review). Nothing else can clear it: an overflow always routes through
      // `onError` -> `fail()`, which tears the recorder down, so the only path
      // back here is a fresh `start()` -- exactly when a retry deserves a clean
      // slate.
      //
      // `queuedBytes` is deliberately *not* reset: writes from the previous
      // session are still outstanding and still decrement it as they land, so
      // it is tracking real bytes, not session-scoped ones.
      overflowed = false;
    },

    async begin(id, mimeType, target): Promise<void> {
      const startedAt = now().toISOString();
      open.set(id, { bytes: 0, mimeType, startedAt });
      await mkdir(deps.dir, { recursive: true });
      // Written *before* any bytes exist, so a segment killed mid-write is
      // still a listed, playable recording rather than an orphan file nothing
      // knows about. See `ScreenRecordingLogEntry`'s doc comment.
      await deps.screenRecordingLog.append({ type: 'opened', id, startedAt, mimeType, target });
    },

    write(chunk: VideoChunk): void {
      const state = open.get(chunk.segmentId);
      if (state === undefined) {
        // A chunk for a segment that was never begun, or was already closed
        // out. Both are reachable and neither is worth failing over: the
        // renderer's final flush can land just after a stop has already
        // finalized the segment. Dropped, with a line, rather than throwing
        // out of an IPC listener.
        logger.warn(`recording: dropped a chunk for unknown segment ${chunk.segmentId}`);
        return;
      }

      if (overflowed) return;

      // Measured *before* committing, so the chunk that trips the bound isn't
      // counted against a backlog it was never added to. Adding first and
      // returning early leaked that increment permanently -- `queuedBytes`
      // could only ever be decremented by a write that actually got enqueued
      // -- which left the writer's idea of its own backlog inflated for the
      // rest of the process's life (review).
      const queuedAfter = queuedBytes + chunk.bytes.byteLength;
      if (queuedAfter > MAX_QUEUED_BYTES) {
        overflowed = true;
        deps.onError(
          `The disk is not keeping up: over ${MAX_QUEUED_BYTES} bytes of video are queued unwritten.`,
        );
        return;
      }
      queuedBytes = queuedAfter;

      state.bytes += chunk.bytes.byteLength;
      const path = segmentPath(deps.dir, chunk.segmentId, state.mimeType);
      const last = chunk.last;
      const id = chunk.segmentId;
      const bytes = chunk.bytes;
      const writeSession = session;

      enqueue(async () => {
        try {
          await appendFile(path, bytes);
        } catch (error) {
          if (writeSession !== session) {
            // A write left over from a session that has already ended. Its
            // failure is real, but it is not the *current* recording's fault
            // and must not tear it down (review) -- reporting it would let a
            // dying disk kill each fresh retry with the previous attempt's
            // error. Logged rather than swallowed: this segment's tail is
            // genuinely lost, and the next launch's `reconcile()` will close
            // it out from whatever did reach disk.
            logger.error(
              `recording: a write from a finished session failed for ${path}: ${describeError(error)}`,
            );
            return;
          }
          deps.onError(`Failed writing ${path}: ${describeError(error)}`);
          return;
        } finally {
          queuedBytes -= bytes.byteLength;
        }

        if (!last) return;

        const finished = open.get(id);
        open.delete(id);
        try {
          await deps.screenRecordingLog.append({
            type: 'closed',
            id,
            endedAt: now().toISOString(),
            bytes: finished?.bytes ?? 0,
          });
        } catch (error) {
          // The bytes are already safely on disk; only the index line failed.
          // Logged rather than escalated, because the startup reconciliation
          // in `coordinator.ts` will synthesize this same `closed` line from
          // the file's real size on the next launch.
          logger.error(`recording: failed to append the closed line for ${id}: ${describeError(error)}`);
        }
      });
    },

    bytesFor: (id) => open.get(id)?.bytes ?? 0,

    pathFor: (id, mimeType) => segmentPath(deps.dir, id, mimeType),

    async prune(id, mimeType): Promise<void> {
      const path = segmentPath(deps.dir, id, mimeType);
      try {
        await removeFile(path);
      } catch (error) {
        // A file already gone (deleted by hand, or a half-finished earlier
        // prune) still deserves its tombstone -- otherwise the index keeps
        // listing a recording that cannot be played, and every later prune
        // re-selects it forever.
        if (!isNotFound(error)) {
          logger.error(`recording: failed to delete ${path}: ${describeError(error)}`);
          return;
        }
      }
      await deps.screenRecordingLog.append({ type: 'pruned', id, prunedAt: now().toISOString() });
    },

    drain: () => chain,
  };
}

/**
 * A segment's filename. The id is a UUID assigned by the coordinator, so this
 * is not user input and cannot contain a separator -- but the playback route
 * still resolves ids through the index and re-checks containment rather than
 * trusting that, since a filename built from a request parameter is exactly
 * the shape path traversal takes.
 */
export function segmentPath(dir: string, id: SegmentId, mimeType: string): string {
  return join(dir, `${id}${extensionFor(mimeType)}`);
}

/** Container extension from the mime type the renderer negotiated. */
export function extensionFor(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? '.mp4' : '.webm';
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
