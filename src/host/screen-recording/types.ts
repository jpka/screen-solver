/**
 * Continuous recording's public vocabulary (#47).
 *
 * The same seam shape as `capture/types.ts` and `config/types.ts`: every
 * capability that only exists through Electron/Chromium is declared here as an
 * injected function type, implemented once in `src/main`, and faked in tests.
 * Nothing in this directory imports Electron.
 *
 * The one structural difference from `capture/types.ts` is the direction of
 * data flow. A capture session is **pulled** — `captureFrame()` asks for one
 * frame when a solve needs it. A recorder is **pushed**: video arrives on the
 * device's clock whether anyone asked for it or not, and a puller that fell
 * behind would have to invent a policy for which frames to drop. So the
 * renderer hands chunks to a {@link VideoChunkSink} as they are produced, and
 * the backpressure question ("what if the disk can't keep up") is answered
 * explicitly in `segment-writer.ts` instead of implicitly by a queue nobody
 * bounded. `feat/audio-transcript` reached the same conclusion for audio.
 */

/**
 * One segment's identity, assigned by the host *before* any of its bytes
 * exist, and echoed back on every chunk belonging to it.
 *
 * Host-assigned rather than renderer-assigned so the index line and the
 * filename are decided by the side that owns the disk: main can name the file,
 * open the handle, and write the `segment` index entry the moment it asks for a
 * roll, rather than discovering a new segment's existence from the first chunk
 * that happens to arrive. It doubles as the routing key — chunks for the
 * outgoing segment can still be in flight when the incoming one starts.
 */
export type SegmentId = string;

/** One `dataavailable` payload from the renderer's `MediaRecorder`, routed by segment. */
export interface VideoChunk {
  readonly segmentId: SegmentId;
  readonly bytes: Uint8Array;
  /**
   * `true` for the final chunk of a segment — the flush `MediaRecorder.stop()`
   * produces. It's the only signal that no further bytes are coming for this
   * segment, which is what lets the writer close the handle and finalize the
   * index entry instead of leaving every past segment's handle open.
   */
  readonly last: boolean;
}

export type VideoChunkSink = (chunk: VideoChunk) => void;

/**
 * A mid-session failure the renderer reports out-of-band (the `MediaRecorder`
 * errored, the track ended underneath it, the stream went away).
 *
 * Separate from an {@link OpenRecorder} rejection, which only covers "it never
 * started". Once a session is open there is no call left to reject, so this is
 * the only channel a failure has.
 */
export interface RecorderFailure {
  readonly reason: string;
}

export interface OpenRecorderOptions {
  /** The segment the first chunks will be tagged with. */
  readonly segmentId: SegmentId;
  readonly sink: VideoChunkSink;
  readonly onFailure: (failure: RecorderFailure) => void;
  /**
   * How often the renderer emits a chunk. This is also the crash-loss window:
   * every chunk is on disk moments after it is produced, so a kill loses at
   * most the timeslice currently being assembled.
   */
  readonly timesliceMs: number;
}

export interface Recorder {
  /**
   * The container the renderer actually negotiated (`video/webm;codecs=vp9`
   * and friends). Chosen in the renderer, because only it can ask
   * `MediaRecorder.isTypeSupported`, but needed here: it decides the segment
   * file's extension and the `content-type` the playback route serves.
   */
  readonly mimeType: string;
  /**
   * Finishes the current segment and begins `next` — implemented as a real
   * `MediaRecorder` stop/start, which is what emits a fresh container header
   * and makes each segment independently playable.
   *
   * Resolves once the outgoing segment's final chunk has been handed to the
   * sink, so a caller that wants "everything for the old segment is now
   * written" can await this and then the writer's own drain.
   */
  roll(next: SegmentId): Promise<void>;
  /** Flushes the open segment's final chunk and tears the recorder down. */
  close(): Promise<void>;
}

/**
 * Opens a recorder over whatever capture stream is currently live.
 *
 * Deliberately takes no target/source argument: it attaches to the stream
 * `capture/session-coordinator.ts` already holds open, rather than grabbing its
 * own. A second `getUserMedia` against the same window would light a second OS
 * capture session — two indicator borders for one window — and would drift out
 * of sync with the target the rest of the app thinks it is watching.
 *
 * Rejects if no capture session is open, or if the renderer never answers.
 */
export type OpenRecorder = (options: OpenRecorderOptions) => Promise<Recorder>;
