import { randomUUID } from 'node:crypto';
import { silentLogger, type Logger } from '../logger.ts';
import type { TranscriptLog } from '../logs/transcript-log.ts';
import type { TranscriptEntry } from '../logs/types.ts';
import type {
  AudioCapture,
  OpenAudioCapture,
  Transcriber,
  TranscriberStream,
  TranscriptChannel,
  TranscriptEvent,
} from './types.ts';
import type { TranscriptWindow } from './window.ts';

/**
 * The recording session lifecycle: audio in, transcript out.
 *
 * Structurally the analogue of `capture/session-coordinator.ts` -- one
 * long-lived thing held open, opened and closed exactly once per session, with
 * every real capability injected so the whole state machine is testable in
 * plain Node. The difference is what drives it: the capture session follows
 * the configured target window, while this follows an explicit toggle and is
 * never persisted. Recording is off on every launch, deliberately: a
 * microphone-adjacent capability that silently resumed itself across restarts
 * would be a surprising thing for this app to do.
 *
 * Only the loopback channel is opened today (see `TranscriptChannel`), so
 * "one capture, one stream" is the whole fan-out. Chunks are still routed by
 * `chunk.channel` rather than assumed, which is what makes adding the
 * microphone later a matter of opening a second stream rather than reworking
 * this.
 */

export type RecordingState =
  /** Never started, or stopped cleanly. */
  | 'off'
  /** `start()` has been called; the socket has not reported itself open yet. */
  | 'starting'
  /** Audio is flowing and transcripts are arriving. */
  | 'on'
  /** The socket dropped; audio is buffering and a reconnect is scheduled. */
  | 'reconnecting'
  /** No transcriber or no capture opener was wired -- `start()` will not do anything. */
  | 'unavailable'
  /** A terminal failure (a rejected key, a rejected audio format). Recoverable only by fixing it and toggling again. */
  | 'error';

export interface RecordingCoordinator {
  state(): RecordingState;
  /** A fresh UUID per `start()`, `null` whenever not recording. Groups `transcript.jsonl` lines. */
  sessionId(): string | null;
  /** Idempotent while already recording. Resolves once the session is set up, not once audio arrives. */
  start(): Promise<RecordingState>;
  stop(): Promise<void>;
  /**
   * Resolves once every `transcript.jsonl` write queued so far has landed --
   * `SolveLogRecorder.drain()`'s twin, and used the same way by
   * `bootstrap.ts`: called after `stop()`, because closing the stream is what
   * produces the last final of all.
   */
  drain(): Promise<void>;
}

export interface RecordingCoordinatorDeps {
  /** Left unset, recording is `'unavailable'` -- the "safe default that just does less" every optional dep here uses. */
  readonly transcriber?: Transcriber;
  /** Left unset, recording is `'unavailable'`. */
  readonly openAudioCapture?: OpenAudioCapture;
  /** Left unset, finals are broadcast but never persisted. */
  readonly transcriptLog?: TranscriptLog;
  /** Left unset, nothing accumulates for "Solve with transcript". */
  readonly transcriptWindow?: TranscriptWindow;
  readonly onTranscript?: (entry: TranscriptEntry) => void;
  readonly onInterim?: (channel: TranscriptChannel, text: string) => void;
  readonly onStateChange?: (state: RecordingState) => void;
  readonly logger?: Logger;
  /** Injected for tests; production uses the real clock. */
  readonly now?: () => Date;
  /** Injected for tests; production uses `crypto.randomUUID`. */
  readonly newSessionId?: () => string;
}

/** Every channel a session opens. One entry today; see `TranscriptChannel`. */
const RECORDED_CHANNELS: readonly TranscriptChannel[] = ['them'];

export function createRecordingCoordinator(
  deps: RecordingCoordinatorDeps = {},
): RecordingCoordinator {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const newSessionId = deps.newSessionId ?? (() => randomUUID());
  const available = deps.transcriber !== undefined && deps.openAudioCapture !== undefined;

  let state: RecordingState = available ? 'off' : 'unavailable';
  let sessionId: string | null = null;
  let capture: AudioCapture | null = null;
  let streams = new Map<TranscriptChannel, TranscriberStream>();
  /**
   * When each channel's current socket opened, in epoch ms. Deepgram's offsets
   * are relative to *that* socket, so this is what turns them into wall-clock
   * time -- and it is reset on every reconnect, because the offsets are too.
   */
  let socketOpenedAtMs = new Map<TranscriptChannel, number>();
  /** Serializes appends so write order matches call order -- see `logs/recorder.ts`. */
  let chain: Promise<void> = Promise.resolve();
  /** Guards against a second `start()` landing while the first is still awaiting `openAudioCapture`. */
  let starting: Promise<RecordingState> | null = null;

  function setState(next: RecordingState): void {
    if (state === next) return;
    state = next;
    deps.onStateChange?.(next);
  }

  function persist(entry: TranscriptEntry): void {
    if (deps.transcriptLog === undefined) return;
    const log = deps.transcriptLog;
    chain = chain
      .then(() => log.append(entry))
      .catch((error: unknown) => {
        // One failed append must not wedge the chain for every later line --
        // the same call `logs/recorder.ts` makes, for the same reason.
        logger.error(
          `transcript: failed to append to transcript.jsonl: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  function handleEvent(channel: TranscriptChannel, event: TranscriptEvent): void {
    switch (event.type) {
      case 'open':
        socketOpenedAtMs.set(channel, now().getTime());
        // Covers both the first connection and a recovery: either way, audio
        // is flowing again.
        if (state === 'starting' || state === 'reconnecting') setState('on');
        return;

      case 'interim':
        deps.onInterim?.(channel, event.text);
        return;

      case 'final': {
        const openedAt = socketOpenedAtMs.get(channel) ?? now().getTime();
        const entry: TranscriptEntry = {
          recordingSessionId: sessionId ?? 'unknown',
          channel,
          text: event.text,
          timestamp: new Date(openedAt + event.endSeconds * 1_000).toISOString(),
          startSeconds: event.startSeconds,
          endSeconds: event.endSeconds,
          model: deps.transcriber?.model ?? 'unknown',
        };
        persist(entry);
        deps.transcriptWindow?.add(entry);
        deps.onTranscript?.(entry);
        return;
      }

      case 'reconnecting':
        logger.warn(
          `transcript: the "${channel}" transcription socket dropped; reconnect attempt ${event.attempt}.`,
        );
        if (state === 'on' || state === 'starting') setState('reconnecting');
        return;

      case 'error':
        logger.error(`transcript: "${channel}" transcription failed (${event.kind}): ${event.message}`);
        setState('error');
        return;
    }
  }

  async function openSession(): Promise<RecordingState> {
    const transcriber = deps.transcriber;
    const openAudioCapture = deps.openAudioCapture;
    if (transcriber === undefined || openAudioCapture === undefined) return 'unavailable';

    sessionId = newSessionId();
    setState('starting');

    streams = new Map(
      RECORDED_CHANNELS.map((channel) => [
        channel,
        transcriber.open({ channel, onEvent: (event) => handleEvent(channel, event) }),
      ]),
    );

    try {
      capture = await openAudioCapture((chunk) => {
        // Routed by the chunk's own channel rather than assumed, so a second
        // source is additive. A chunk for a channel this session didn't open
        // is dropped rather than crashing the audio callback.
        streams.get(chunk.channel)?.send(chunk.pcm);
      });
    } catch (error) {
      logger.error(
        `transcript: could not start audio capture: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await closeEverything();
      setState('error');
      return state;
    }

    // An `error` event (a rejected key) can already have landed while
    // `openAudioCapture` was in flight; don't overwrite it with a rosier state.
    if (state === 'starting' || state === 'on' || state === 'reconnecting') return state;
    return state;
  }

  async function closeEverything(): Promise<void> {
    const openCapture = capture;
    capture = null;
    const openStreams = [...streams.values()];
    streams = new Map();
    socketOpenedAtMs = new Map();

    // Capture first: stop producing audio before closing the thing consuming
    // it, so no chunk is handed to a stream that is already flushing.
    try {
      await openCapture?.close();
    } catch (error) {
      logger.warn(
        `transcript: audio capture did not close cleanly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Each stream bounds its own close (`CLOSE_TIMEOUT_MS`), which is what
    // lets this whole thing sit inside `bootstrap.ts`'s single drain budget.
    await Promise.all(
      openStreams.map(async (stream) => {
        try {
          await stream.close();
        } catch (error) {
          logger.warn(
            `transcript: a transcription stream did not close cleanly: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  }

  return {
    state: () => state,
    sessionId: () => sessionId,

    async start() {
      if (!available) return 'unavailable';
      if (starting !== null) return starting;
      if (state === 'on' || state === 'starting' || state === 'reconnecting') return state;

      const attempt = openSession();
      starting = attempt;
      try {
        return await attempt;
      } finally {
        starting = null;
      }
    },

    async stop() {
      if (starting !== null) {
        // Never tear down a half-built session: let the open finish, then
        // close what it actually produced.
        await starting.catch(() => {});
      }
      if (state === 'off' || state === 'unavailable') return;

      await closeEverything();
      sessionId = null;
      // The next session starts with a clean context rather than inheriting
      // sentences from the last one.
      deps.transcriptWindow?.clear();
      setState('off');
    },

    drain: () => chain,
  };
}
