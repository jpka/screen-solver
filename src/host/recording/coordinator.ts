import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { TargetWindowIdentity } from '../config/types.ts';
import { silentLogger, type Logger } from '../logger.ts';
import type { RecordingLog } from '../logs/recording-log.ts';
import type { RecordingSegment } from '../logs/types.ts';
import { selectSegmentsToPrune } from './retention.ts';
import { shouldRollSegment } from './segment-policy.ts';
import { extensionFor, type SegmentWriter } from './segment-writer.ts';
import type { OpenRecorder, Recorder, SegmentId } from './types.ts';

/**
 * The recording session lifecycle (#45).
 *
 * Structurally `capture/session-coordinator.ts`'s sibling: one long-lived thing
 * held open, every real capability injected so the whole state machine runs in
 * plain Node with no Electron, and supersession handled by a generation counter
 * rather than a lock. What differs is what drives it. The capture session
 * follows the *configured target*; this follows the *capture session itself*
 * -- there is nothing to record when no stream is open -- plus an explicit
 * on/off the user controls.
 *
 * Recording is off until something turns it on, and `RecordingSettings.enabled`
 * is what makes that automatic across restarts. That is a deliberate departure
 * from `feat/audio-transcript`'s "never persisted" rule, argued in
 * `config/types.ts`: automatic recording is this ticket's entire premise, and
 * the safety the audio branch was protecting is preserved by the OS capture
 * indicator and a conspicuous live REC state in the client instead.
 */

export type RecordingState =
  /** Not recording. The resting state, and where a clean stop lands. */
  | 'off'
  /** `start()` is in flight -- the renderer hasn't confirmed a `MediaRecorder` yet. */
  | 'starting'
  /** Chunks are arriving and landing on disk. */
  | 'recording'
  /** No recorder opener was wired. `start()` will never do anything. */
  | 'unavailable'
  /** A terminal failure (disk full, write backlog, renderer error). Recoverable by fixing it and starting again. */
  | 'error';

export interface RecordingSnapshot {
  readonly state: RecordingState;
  readonly segmentId: SegmentId | null;
  readonly bytes: number;
  /** ISO 8601 for when the *session* started (not the current segment). */
  readonly startedAt: string | null;
  /** Populated only in `error`. */
  readonly reason: string | null;
}

export interface RecordingCoordinator {
  snapshot(): RecordingSnapshot;
  /**
   * Subscribes to state changes. Call the returned function to unsubscribe.
   *
   * A subscription rather than a constructor callback, matching
   * `ConfigStore.onChange`: `createHostRoutes` owns the `EventBroadcaster` and
   * builds it internally, so a coordinator constructed before the routes (as
   * `bootstrap.ts` must, since the routes take the coordinator as a dependency)
   * has nothing to hand a callback at construction time. Subscribing after the
   * fact breaks that cycle without a mutable trampoline.
   */
  onStateChange(listener: (snapshot: RecordingSnapshot) => void): () => void;
  /** Idempotent while already recording. Resolves once a segment is open, not once bytes arrive. */
  start(): Promise<RecordingSnapshot>;
  /** Flushes the open segment and returns to `off`. Idempotent. */
  stop(): Promise<void>;
  /**
   * Reports a failure raised outside the recorder itself -- in practice the
   * segment writer's disk errors and queue overflow.
   *
   * Public because the writer is constructed *before* the coordinator that owns
   * it (it is one of its dependencies), so it cannot be handed a callback into
   * something that doesn't exist yet. Calls during an expected teardown are
   * ignored; see the `stopping` flag.
   */
  fail(reason: string): void;
  /**
   * Tells the coordinator whether a capture stream exists to record. Wired to
   * `CaptureSessionCoordinator`'s `onSessionChange`, which calls it with `null`
   * *before* closing a stream and with the new target *after* opening one.
   *
   * A target change is a genuine stream swap underneath us, so it ends the
   * current segment and starts a fresh one rather than pretending the recording
   * continued -- the two halves would be different windows.
   *
   * Returns a promise the capture coordinator awaits (bounded), which is what
   * makes the `null` call useful: the recorder gets to flush its final chunk
   * while the tracks are still live, instead of having them stopped underneath
   * it mid-segment.
   */
  onCaptureSessionChange(target: TargetWindowIdentity | null): Promise<void>;
  /**
   * One pass of the roll/retention clock. Driven by an internal timer in
   * production; exposed so tests can advance it deterministically instead of
   * sleeping.
   */
  tick(): Promise<void>;
  /** Reconciles crash orphans and prunes on startup. Safe to call once, before anything else. */
  reconcile(): Promise<void>;
  /** Drains every queued write. `SolveLogRecorder.drain()`'s twin; `bootstrap.ts` uses it the same way. */
  drain(): Promise<void>;
}

export interface RecordingCoordinatorDeps {
  readonly writer: SegmentWriter;
  readonly recordingLog: RecordingLog;
  /** Left unset, recording is `'unavailable'` -- the "safe default that just does less" every optional dep in this repo uses. */
  readonly openRecorder?: OpenRecorder;
  /** Reads the live settings each time they're needed, so a change takes effect without restarting the coordinator. */
  readonly settings: () => {
    readonly enabled: boolean;
    readonly segmentSeconds: number;
    readonly retentionBytes: number;
    readonly retentionDays: number;
  };
  /** The window currently being captured, for the index entry. */
  readonly currentTarget: () => TargetWindowIdentity | null;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly newSegmentId?: () => SegmentId;
  /** How often the renderer emits a chunk; also the crash-loss window. */
  readonly timesliceMs?: number;
  /** Injected for tests; production stats the real file during reconciliation. */
  readonly fileSize?: (path: string) => Promise<number>;
  /**
   * Overrides `segment-policy.ts`'s {@link MAX_SEGMENT_BYTES}. Injected by
   * tests that need to reach the size-based roll without actually writing
   * hundreds of megabytes; production never sets it.
   *
   * Worth being clear that this bound and `segment-writer.ts`'s
   * {@link MAX_QUEUED_BYTES} measure different things, despite both being byte
   * counts: this one is the total size a finished segment may reach, while that
   * one is how much may sit *unwritten* at any instant. A segment can grow far
   * past the queue bound without ever tripping it, so long as the disk keeps up.
   */
  readonly maxSegmentBytes?: number;
}

/**
 * One chunk per second.
 *
 * This single number sets both how much a crash can lose (at most the chunk
 * being assembled) and how chatty the IPC channel is. A second is small enough
 * that losing one is imperceptible and large enough that the base64 framing
 * overhead stays irrelevant.
 */
const DEFAULT_TIMESLICE_MS = 1_000;

/** How often the roll/retention clock runs. Well under the smallest allowed `segmentSeconds`. */
const TICK_MS = 1_000;

export function createRecordingCoordinator(deps: RecordingCoordinatorDeps): RecordingCoordinator {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const newSegmentId = deps.newSegmentId ?? (() => randomUUID());
  const timesliceMs = deps.timesliceMs ?? DEFAULT_TIMESLICE_MS;
  const fileSize = deps.fileSize ?? (async (path: string) => (await stat(path)).size);

  let state: RecordingState = deps.openRecorder === undefined ? 'unavailable' : 'off';
  let reason: string | null = null;
  let recorder: Recorder | null = null;
  let segmentId: SegmentId | null = null;
  let segmentOpenedAt = 0;
  let sessionStartedAt: string | null = null;
  let sessionBytes = 0;
  let generation = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  /**
   * True while a stop we asked for is in flight.
   *
   * The renderer honestly reports "the capture stream stopped underneath the
   * active recording" as a failure, because from its side that is exactly what
   * it looks like. During a deliberate stop -- and during the window between a
   * target change and the stream actually closing -- it is expected, not a
   * fault, and must not strand the coordinator in `error` on every ordinary
   * window switch.
   */
  let stopping = false;
  /** Serializes start/stop/roll so two of them can never interleave on one recorder. */
  let transition: Promise<void> = Promise.resolve();
  const listeners = new Set<(snapshot: RecordingSnapshot) => void>();

  function publish(): void {
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        // A listener that throws is its own problem; it must not be able to
        // abort a roll or a state transition mid-way.
        logger.error(`recording: a state listener threw: ${describeError(error)}`);
      }
    }
  }

  function snapshot(): RecordingSnapshot {
    return {
      state,
      segmentId,
      bytes: sessionBytes + (segmentId === null ? 0 : deps.writer.bytesFor(segmentId)),
      startedAt: sessionStartedAt,
      reason,
    };
  }

  function setState(next: RecordingState, nextReason: string | null = null): void {
    // Suppressed no-op transitions, for `solve/status.ts`'s reason: the caller
    // shouldn't have to diff snapshots just to avoid a duplicate SSE frame.
    if (state === next && reason === nextReason) return;
    state = next;
    reason = nextReason;
    publish();
  }

  function fail(message: string): void {
    if (stopping || (recorder === null && state !== 'starting')) {
      // Expected teardown noise, or a failure from a recorder we already let
      // go of. Logged at info so it stays visible without being alarming.
      logger.info(`recording: ignoring a failure during teardown: ${message}`);
      return;
    }
    logger.error(`recording: ${message}`);
    // Torn down without awaiting: whatever went wrong (a wedged renderer, a
    // dead disk) is exactly the kind of thing whose `close()` may never
    // resolve, and the state has to move now regardless.
    const dying = recorder;
    recorder = null;
    segmentId = null;
    stopTicker();
    setState('error', message);
    void dying?.close().catch(() => {});
  }

  function startTicker(): void {
    if (ticker !== null) return;
    ticker = setInterval(() => {
      void run().catch(() => {});
    }, TICK_MS);
    // Never hold the process open on this alone -- shutdown decides when the
    // app ends, not the recording clock.
    ticker.unref?.();
  }

  function stopTicker(): void {
    if (ticker === null) return;
    clearInterval(ticker);
    ticker = null;
  }

  /** Queues `work` behind whatever start/stop/roll is already in flight. */
  function serialize(work: () => Promise<void>): Promise<void> {
    const next = transition.then(work, work);
    transition = next.catch(() => {});
    return next;
  }

  async function openSegment(): Promise<SegmentId> {
    const id = newSegmentId();
    await deps.writer.begin(id, recorder?.mimeType ?? 'video/webm', deps.currentTarget());
    segmentId = id;
    segmentOpenedAt = now().getTime();
    return id;
  }

  async function run(): Promise<void> {
    if (state !== 'recording' || recorder === null || segmentId === null) return;

    const settings = deps.settings();
    const openId = segmentId;
    const elapsedMs = now().getTime() - segmentOpenedAt;
    const bytes = deps.writer.bytesFor(openId);

    if (
      !shouldRollSegment({
        elapsedMs,
        bytes,
        segmentSeconds: settings.segmentSeconds,
        maxSegmentBytes: deps.maxSegmentBytes,
      })
    ) {
      // Still worth republishing: the client's live byte counter is fed by
      // this event, and nothing else changes while a segment is mid-flight.
      publish();
      return;
    }

    const myGeneration = generation;
    await serialize(async () => {
      if (myGeneration !== generation || recorder === null || segmentId !== openId) return;
      const nextId = newSegmentId();
      try {
        await recorder.roll(nextId);
      } catch (error) {
        fail(`failed to roll to a new segment: ${describeError(error)}`);
        return;
      }
      // The outgoing segment's byte total is only final once its last chunk
      // has been counted, which `roll()` resolving guarantees.
      sessionBytes += deps.writer.bytesFor(openId);
      await deps.writer.begin(nextId, recorder.mimeType, deps.currentTarget());
      segmentId = nextId;
      segmentOpenedAt = now().getTime();
      publish();
    });

    // Drained first, deliberately. Retention reasons about the index, and the
    // segment that just rolled only gets its `closed` line -- and therefore its
    // real byte total -- once the writer's chain reaches it. Pruning before
    // that lands reads the outgoing segment as zero bytes, so the byte budget
    // is computed against a total that is always one segment short and
    // retention quietly keeps more than it was asked to. Caught by a test that
    // was flaky precisely because it depended on whether the append had
    // happened to resolve yet.
    await deps.writer.drain();
    await pruneToLimits();
  }

  /** Applies the retention limits. Failures are logged, never fatal -- a full disk is already being handled elsewhere. */
  async function pruneToLimits(): Promise<void> {
    const settings = deps.settings();
    let index: readonly RecordingSegment[];
    try {
      index = await deps.recordingLog.readIndex();
    } catch (error) {
      logger.error(`recording: could not read the index to apply retention: ${describeError(error)}`);
      return;
    }

    const doomed = selectSegmentsToPrune({
      segments: index,
      retentionBytes: settings.retentionBytes,
      retentionDays: settings.retentionDays,
      now: now(),
      openSegmentId: segmentId,
    });

    for (const id of doomed) {
      const segment = index.find((candidate) => candidate.id === id);
      if (segment === undefined) continue;
      await deps.writer.prune(id, segment.mimeType);
      logger.info(`recording: pruned segment ${id} (${segment.bytes} bytes)`);
    }
  }

  function startRecording(): Promise<RecordingSnapshot> {
    return serialize(async () => {
        if (state === 'unavailable') return;
        if (state === 'recording' || state === 'starting') return;
        if (deps.openRecorder === undefined) return;

        generation += 1;
        const myGeneration = generation;
        stopping = false;
        setState('starting');
        sessionBytes = 0;
        sessionStartedAt = now().toISOString();

        const firstId = newSegmentId();
        let opened: Recorder;
        try {
          opened = await deps.openRecorder({
            segmentId: firstId,
            timesliceMs,
            sink: (chunk) => deps.writer.write(chunk),
            onFailure: (failure) => fail(failure.reason),
          });
        } catch (error) {
          setState('error', describeError(error));
          sessionStartedAt = null;
          return;
        }

        if (myGeneration !== generation) {
          // A stop (or another start) superseded this one while the renderer
          // was still opening. Tear down what was just built rather than
          // adopting it -- `capture.js`'s own `sessionToken` guard, one layer
          // up.
          await opened.close().catch(() => {});
          return;
        }

        recorder = opened;
        segmentId = firstId;
        segmentOpenedAt = now().getTime();
        await deps.writer.begin(firstId, opened.mimeType, deps.currentTarget());
        setState('recording');
        startTicker();
    }).then(snapshot);
  }

  function stopRecording(): Promise<void> {
    // Set outside the queued work, not inside it: the renderer's "the stream
    // stopped underneath me" failure can arrive while this stop is still
    // waiting its turn in the transition chain, and suppressing it only once
    // the work began would leave exactly that gap unguarded.
    stopping = true;
    return serialize(async () => {
      generation += 1;
      stopTicker();
      const dying = recorder;
      recorder = null;
      segmentId = null;
      sessionStartedAt = null;
      sessionBytes = 0;
      if (dying !== null) {
        try {
          await dying.close();
        } catch (error) {
          logger.error(`recording: failed to close the recorder: ${describeError(error)}`);
        }
      }
      // A deliberate stop clears a standing `error` too: the user has
      // acknowledged it, and leaving it latched would mean the next start
      // reported a fault that is no longer true.
      setState(state === 'unavailable' ? 'unavailable' : 'off');
      stopping = false;
    });
  }

  return {
    snapshot,

    onStateChange(listener: (snapshot: RecordingSnapshot) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start: startRecording,

    stop: stopRecording,

    fail,

    async onCaptureSessionChange(target: TargetWindowIdentity | null): Promise<void> {
      if (state === 'unavailable') return;

      if (target === null) {
        // Called before the stream is actually closed, so this is the recorder's
        // chance to flush cleanly. A target simply vanishing is ordinary (#32's
        // mid-run loss), so it stops rather than erroring.
        if (state === 'recording' || state === 'starting') await stopRecording();
        return;
      }

      // Called after a fresh stream is open. Only `enabled` makes recording
      // follow it automatically; without that, a user who stopped by hand
      // would find recording silently restarting itself on every window switch.
      if (!deps.settings().enabled) return;

      if (state === 'recording' || state === 'starting') await stopRecording();
      await startRecording();
    },

    tick: run,

    async reconcile(): Promise<void> {
      // A segment with an `opened` line and no `closed` one means the app died
      // mid-recording. The bytes are intact -- that is the entire point of
      // appending as we go -- so the honest repair is to measure the file and
      // write the `closed` line that never got written, marked `recovered` so
      // "the process died" stays distinguishable from "the user stopped".
      let index: readonly RecordingSegment[];
      try {
        index = await deps.recordingLog.readIndex();
      } catch (error) {
        logger.error(`recording: could not read the index at startup: ${describeError(error)}`);
        return;
      }

      for (const segment of index) {
        if (segment.endedAt !== null) continue;
        const path = deps.writer.pathFor(segment.id, segment.mimeType);
        let bytes: number;
        try {
          bytes = await fileSize(path);
        } catch {
          // The `opened` line outlived its file. Tombstone it so the index
          // stops advertising a recording that cannot be played.
          await deps.writer.prune(segment.id, segment.mimeType).catch(() => {});
          continue;
        }
        await deps.recordingLog
          .append({
            type: 'closed',
            id: segment.id,
            endedAt: now().toISOString(),
            bytes,
            recovered: true,
          })
          .catch((error: unknown) => {
            logger.error(`recording: failed to recover segment ${segment.id}: ${describeError(error)}`);
          });
        logger.info(`recording: recovered segment ${segment.id} (${bytes} bytes) after an unclean exit`);
      }

      await pruneToLimits();
    },

    async drain(): Promise<void> {
      await transition.catch(() => {});
      await deps.writer.drain();
    },
  };
}

/** Re-exported so `http/routes.ts` can build a filename without importing the writer's internals. */
export { extensionFor };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
