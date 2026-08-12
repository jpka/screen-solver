import {
  createRecordingCoordinator,
  type RecordingCoordinator,
} from '../audio/recording-coordinator.ts';
import type { OpenAudioCapture, Transcriber } from '../audio/types.ts';
import type { TranscriptWindow } from '../audio/window.ts';
import type { TargetIntentTracker } from '../capture/intent.ts';
import type { IsTargetMinimized } from '../capture/types.ts';
import type { CaptureSessionCoordinator } from '../capture/session-coordinator.ts';
import type { ConfigStore } from '../config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity } from '../config/types.ts';
import type { AnswerLog } from '../logs/answer-log.ts';
import type { TranscriptLog } from '../logs/transcript-log.ts';
import type { Logger } from '../logger.ts';
import type { Provider } from '../provider/types.ts';
import { createEventBroadcaster } from '../solve/broadcaster.ts';
import { startSolveLoop, type SolveLoop } from '../solve/loop.ts';
import type { SolveOutcomeEvent } from '../solve/types.ts';
import { PayloadTooLargeError, readJsonBody, sendJson, type Route } from './router.ts';

/**
 * How many transcript lines `GET /transcript` serves when the client doesn't
 * say. Enough to fill a pane and scroll back through a long meeting, without
 * making a phone parse an entire history that grows one line every few
 * seconds of speech -- the one way this route has to differ from `GET
 * /answers`, which grows one line per button press and can afford to be total.
 */
export const DEFAULT_TRANSCRIPT_LIMIT = 500;

/** A ceiling on what one request can ask this process to read and serialize. */
export const MAX_TRANSCRIPT_LIMIT = 5_000;

export interface HostRoutesDeps {
  /**
   * #28's live config store -- `POST /solve` reads `.get().targetWindow`
   * synchronously to decide `400` vs `202`. #33 also builds `GET /config`,
   * `GET /windows`, and `POST /config/target` directly off this (the window
   * picker's entire HTTP surface), and wires `onChange` to the broadcaster's
   * `config{target}` SSE frame so a connected client learns about a target
   * change live.
   */
  readonly configStore?: ConfigStore;
  /** #30's capture session coordinator -- the frame-grab half of the pre-flight guard. */
  readonly captureSessionCoordinator?: CaptureSessionCoordinator;
  /** #27's provider seam -- the model call the solve loop actually makes once a frame clears both guards. */
  readonly provider?: Provider;
  /** #28's window enumeration, reused for the "still present" half of the pre-flight guard. Left unset, every target looks vanished. */
  readonly enumerateWindows?: EnumerateWindows;
  /** #30's minimized check, the other half of the pre-flight guard. Left unset, no target is ever treated as minimized. */
  readonly isTargetMinimized?: IsTargetMinimized;
  /** #32's deliberate-pause-vs-unexpected-loss intent flag. Left unset, a fresh always-`'active'` tracker is used -- every vanished target is treated as an unexpected loss. */
  readonly targetIntent?: TargetIntentTracker;
  /** #29's internal outcome bus -- see `src/host/solve/types.ts`. #31's `bootstrap.ts` wires this to a `SolveLogRecorder` that writes `answers.jsonl`/`usage.jsonl`. */
  readonly onOutcome?: (event: SolveOutcomeEvent) => void | Promise<void>;
  /** #31's `answers.jsonl` reader -- `GET /answers` serves its full backlog. Left unset, `GET /answers` answers `[]` (the same "nothing configured yet" default `enumerateWindows`/`isTargetMinimized` already use). */
  readonly answerLog?: AnswerLog;
  /**
   * The transcription seam. `bootstrap.ts` builds a real Deepgram transcriber
   * when a key is present. Left unset, recording reports `'unavailable'` and
   * `POST /recording` refuses -- the same "safe default that just does less"
   * shape as everything above it.
   */
  readonly transcriber?: Transcriber;
  /** Loopback audio capture. Electron supplies the real implementation; left unset, recording is `'unavailable'`. */
  readonly openAudioCapture?: OpenAudioCapture;
  /** `transcript.jsonl`. `GET /transcript` serves its tail. Left unset, that route answers `[]` and finals are broadcast but not persisted. */
  readonly transcriptLog?: TranscriptLog;
  /** The bounded recent-speech buffer `POST /solve/with-transcript` reads. Left unset, nothing accumulates. */
  readonly transcriptWindow?: TranscriptWindow;
  readonly logger?: Logger;
}

export interface HostRoutes {
  readonly routes: readonly Route[];
  /**
   * The solve loop backing `POST /solve`, `null` when `configStore`/
   * `captureSessionCoordinator`/`provider` weren't all supplied (the same
   * condition that makes `POST /solve` answer `503` below). `bootstrap.ts`
   * calls `.stop()` on shutdown so the in-flight attempt's outcome -- and
   * #31's persistence of it -- finishes before the process exits, instead of
   * being silently abandoned mid-write, and so no *further* attempt can start
   * in the window before the server stops listening.
   */
  readonly solveLoop: SolveLoop | null;
  /**
   * The recording lifecycle backing `POST /recording`. Always present, unlike
   * {@link solveLoop}: a coordinator with nothing wired into it is a perfectly
   * good object that reports `'unavailable'`, which is a more honest answer to
   * `GET /recording` than a `503` claiming the server isn't ready -- it is
   * ready, it just has no transcription key. `bootstrap.ts` calls `stop()` and
   * `drain()` on shutdown.
   */
  readonly recordingCoordinator: RecordingCoordinator;
}

/**
 * The routes the host serves.
 *
 * `configStore`, `captureSessionCoordinator`, and `provider` are all optional
 * so `createHostRoutes()` still works with no arguments (existing tests of
 * `/health` and generic routing rely on exactly that) -- but `POST /solve`
 * treats their absence as "the server itself isn't ready to accept a solve"
 * and answers `503`. In production this is unreachable: `bootstrapHost`
 * always supplies all three (a provider always exists once startup has
 * succeeded, since a missing API key already refused to start) -- the `503`
 * branch exists for routes constructed directly, the way a route-level test
 * does.
 */
export function createHostRoutes(deps: HostRoutesDeps = {}): HostRoutes {
  const broadcaster = createEventBroadcaster();
  const { configStore, captureSessionCoordinator, provider } = deps;

  const solveLoop =
    configStore !== undefined && captureSessionCoordinator !== undefined && provider !== undefined
      ? startSolveLoop({
          configStore,
          captureSessionCoordinator,
          provider,
          broadcaster,
          enumerateWindows: deps.enumerateWindows,
          isTargetMinimized: deps.isTargetMinimized,
          targetIntent: deps.targetIntent,
          onOutcome: deps.onOutcome,
          transcriptWindow: deps.transcriptWindow,
          logger: deps.logger,
        })
      : null;

  // #33: mirrors every target-window change onto the SSE wire, so a
  // connected client reacts live (a fresh pick, or #32's own mid-run
  // fallback to `null`) without a reload. Subscribed for the process's
  // whole lifetime, the same as `startCaptureSessionCoordinator`'s own
  // `configStore.onChange` subscription in `bootstrap.ts` -- there is no
  // teardown path for `createHostRoutes` itself to hook a matching
  // `unsubscribe` into.
  if (configStore !== undefined) {
    configStore.onChange((event) => {
      broadcaster.config(event.target);
    });
  }

  // Built here rather than taken as a dependency, the same way `solveLoop` is
  // and for the same reason: it needs the broadcaster, and the broadcaster is
  // constructed in this function. Its three callbacks are the whole bridge
  // between the audio subsystem and the wire.
  const recordingCoordinator = createRecordingCoordinator({
    transcriber: deps.transcriber,
    openAudioCapture: deps.openAudioCapture,
    transcriptLog: deps.transcriptLog,
    transcriptWindow: deps.transcriptWindow,
    onTranscript: (entry) => broadcaster.transcript(entry),
    onInterim: (channel, text) => broadcaster.transcriptInterim(channel, text),
    onStateChange: (state) => broadcaster.recording(state),
    logger: deps.logger,
  });

  // Note the split of responsibility below: `GET /recording` reads its *state*
  // from the coordinator and its *revision* from the broadcaster.
  //
  // That looks like two sources for one fact, but it isn't. `onStateChange`
  // fires synchronously on every real transition and bumps the revision with
  // it, so the two can only ever differ on the state the coordinator was
  // *born* in -- which is `'unavailable'` (no transcription key), a state that
  // is fixed at construction and can never change while the process runs. The
  // rejected alternative was to seed the broadcaster with that initial state
  // instead: it would make the two agree, but at the cost of replaying a
  // `recording` frame to every client that ever connects, in order to announce
  // something static that `GET /recording` already tells them on load. The SSE
  // stream is for things that change.
  const recordingState = (): ReturnType<RecordingCoordinator['state']> =>
    recordingCoordinator.state();

  /**
   * Both solve routes, differing only in whether the attempt carries recent
   * speech. Everything else -- the guards, the status codes, the synchronous
   * abort-then-202 -- is shared by construction rather than by copy, so the
   * plain route cannot drift as the transcript one grows.
   */
  function solveHandler(includeTranscript: boolean): Route['handle'] {
    return ({ res }) => {
      if (solveLoop === null || configStore === undefined) {
        sendJson(res, 503, { error: 'not_ready' });
        return;
      }

      const target = configStore.get().targetWindow;
      if (target === null) {
        sendJson(res, 400, { error: 'no_target_configured' });
        return;
      }

      // Synchronous with the 202 below: whatever solve was in flight is
      // aborted right here. The pre-flight guards and the provider call for
      // this new solve run asynchronously, after the response has already
      // gone out (#29's own body: "This abort is synchronous with the 202").
      //
      // The one way this comes back refused is shutdown having already begun
      // (`SolveLoop.stop()`): the server is still listening for the moment it
      // takes to close, but nothing is left to run or persist a new attempt,
      // so say so rather than accepting work that will silently evaporate.
      if (!solveLoop.trigger({ includeTranscript })) {
        sendJson(res, 503, { error: 'shutting_down' });
        return;
      }
      sendJson(res, 202, { status: 'accepted' });
    };
  }

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/health',
      handle: ({ res }) => {
        sendJson(res, 200, { status: 'ok', service: 'screen-solver' });
      },
    },
    {
      method: 'POST',
      path: '/solve',
      handle: solveHandler(false),
    },
    {
      // The transcript-flavoured solve.
      //
      // A separate route rather than a body flag on `POST /solve`, deliberately.
      // That route reads no request body at all today, and its contract is
      // total: 202 unless not-ready / no-target / shutting-down. Adding a body
      // would introduce `400 bad_request` and `413 payload_too_large` failure
      // modes to a route several existing tests assert has none, to express one
      // bit. `AGENTS.md` frames this flat route list as a place where new
      // capability is an append, not surgery -- so this is an append, and both
      // handlers come from the same factory so the two can't drift.
      method: 'POST',
      path: '/solve/with-transcript',
      handle: solveHandler(true),
    },
    {
      method: 'GET',
      path: '/events',
      handle: ({ req, res }) => {
        const unsubscribe = broadcaster.subscribe(res);
        req.on('close', unsubscribe);
      },
    },
    {
      method: 'GET',
      path: '/answers',
      handle: async ({ res }) => {
        // Independent of the live `/events` connection (spec): reads
        // `answers.jsonl` fresh on every request, no in-memory cache to keep
        // in sync -- `deps.answerLog` itself already has this property
        // (`logs/jsonl.ts`'s `readAll()`), so there's nothing extra to do
        // here beyond serving whatever it hands back.
        const entries = deps.answerLog === undefined ? [] : await deps.answerLog.readAll();
        sendJson(res, 200, entries);
      },
    },
    {
      // #33: the one thing a client can't learn from `GET /events` alone --
      // what the target is *right now*, on first load, before any `config`
      // frame has ever been broadcast. Kept deliberately narrow (just the
      // field the picker cares about) rather than exposing the whole
      // `ScreenSolverConfig`, since `provider` is reserved and unused by any
      // ticket through #33. `revision` is `broadcaster.ts`'s own counter --
      // see its doc comment on `SseEvent`'s `config` variant -- so a client
      // can tell whether this snapshot is newer or older than a `config` SSE
      // frame it may have already received, rather than just trusting
      // whichever happened to arrive first over its own separate connection.
      method: 'GET',
      path: '/config',
      handle: ({ res }) => {
        if (configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }
        sendJson(res, 200, {
          targetWindow: configStore.get().targetWindow,
          revision: broadcaster.currentConfigRevision(),
        });
      },
    },
    {
      // #33: the window picker's list -- same enumeration `POST /solve`'s
      // pre-flight guard already reaches through `configStore`, just exposed
      // directly rather than only consumed internally.
      method: 'GET',
      path: '/windows',
      handle: async ({ res }) => {
        if (configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }
        const windows = await configStore.listWindows();
        sendJson(res, 200, windows);
      },
    },
    {
      // #33: the picker's "commit a choice" action. A JSON body of
      // `{processName, title}` sets the target; an explicit `null` body (or
      // no body at all -- `readJsonBody`'s own empty-body default) clears it.
      // A malformed body (bad shape or bad JSON) is `400`, same status
      // `router.ts`'s own bad-URL guard already uses for "this request
      // doesn't make sense"; a body over `readJsonBody`'s own byte cap is
      // `413`.
      method: 'POST',
      path: '/config/target',
      handle: async ({ req, res }) => {
        if (configStore === undefined) {
          sendJson(res, 503, { error: 'not_ready' });
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            sendJson(res, 413, { error: 'payload_too_large' });
          } else {
            sendJson(res, 400, { error: 'bad_request' });
          }
          return;
        }

        const target = parseTargetBody(body);
        if (target === INVALID_TARGET) {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }

        await configStore.setTargetWindow(target);
        // `setTargetWindow` above has already driven the `onChange`
        // subscription (below) synchronously, so `currentConfigRevision()`
        // here is exactly the revision the resulting `config` SSE frame
        // carried -- this response is just as fresh as that frame.
        sendJson(res, 200, { targetWindow: target, revision: broadcaster.currentConfigRevision() });
      },
    },
    {
      // The recording toggle's read side -- what a client needs on first load,
      // before any `recording` SSE frame has been broadcast. Deliberately not
      // folded into `GET /config`: that route is the narrow view of *persisted*
      // `config.json`, and recording state is deliberately never persisted, so
      // sharing a route would also mean sharing a revision counter between two
      // things that change independently.
      method: 'GET',
      path: '/recording',
      handle: ({ res }) => {
        sendJson(res, 200, {
          state: recordingState(),
          sessionId: recordingCoordinator.sessionId(),
          revision: broadcaster.recordingSnapshot().revision,
        });
      },
    },
    {
      // The toggle's write side. `{on: true|false}` only -- unlike
      // `POST /config/target`, an empty or `null` body has no sensible meaning
      // here ("toggle to nothing"?), so it is a `400` rather than a default.
      method: 'POST',
      path: '/recording',
      handle: async ({ req, res }) => {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            sendJson(res, 413, { error: 'payload_too_large' });
          } else {
            sendJson(res, 400, { error: 'bad_request' });
          }
          return;
        }

        const on = parseRecordingBody(body);
        if (on === null) {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }

        if (recordingState() === 'unavailable') {
          // No transcription key, or no capture opener. Distinct from
          // `not_ready`: the server is fine, this one capability isn't wired.
          sendJson(res, 503, { error: 'recording_unavailable' });
          return;
        }

        if (on) {
          await recordingCoordinator.start();
        } else {
          await recordingCoordinator.stop();
        }

        // Every state transition above has already driven `onStateChange` ->
        // `broadcaster.recording()` synchronously, so this revision is exactly
        // the one the SSE frame it caused carried -- the same property
        // `POST /config/target` relies on.
        sendJson(res, 200, {
          state: recordingState(),
          sessionId: recordingCoordinator.sessionId(),
          revision: broadcaster.recordingSnapshot().revision,
        });
      },
    },
    {
      // The transcript backlog, read fresh on every request exactly as
      // `GET /answers` is. Capped, which `GET /answers` is not -- see
      // `DEFAULT_TRANSCRIPT_LIMIT`. A query parameter, so `router.ts`'s
      // "no path parameters" invariant is untouched.
      method: 'GET',
      path: '/transcript',
      handle: async ({ res, url }) => {
        const limit = parseLimit(url.searchParams.get('limit'));
        if (limit === null) {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }
        // `readTail`, not `readAll().slice()`: this file grows one line every
        // few seconds of speech, so reading the whole history to serve the
        // last 500 lines is work proportional to everything ever said, on
        // every request (review feedback -- the response was bounded but the
        // read was not).
        const entries =
          deps.transcriptLog === undefined ? [] : await deps.transcriptLog.readTail(limit);
        sendJson(res, 200, entries);
      },
    },
  ];

  return { routes, solveLoop, recordingCoordinator };
}

/** `true`/`false` from `{on}`, or `null` for anything this route can't act on. */
function parseRecordingBody(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null) return null;
  const on = (body as Record<string, unknown>).on;
  return typeof on === 'boolean' ? on : null;
}

/** The requested page size, or `null` if the client asked for something incoherent. */
function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_TRANSCRIPT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (value < 1) return null;
  return Math.min(value, MAX_TRANSCRIPT_LIMIT);
}

const INVALID_TARGET = Symbol('invalid-target');

/** `null` (clear), a well-formed `{processName, title}` (set), or {@link INVALID_TARGET}. */
function parseTargetBody(body: unknown): TargetWindowIdentity | null | typeof INVALID_TARGET {
  if (body === null) return null;
  if (
    typeof body === 'object' &&
    typeof (body as Record<string, unknown>).processName === 'string' &&
    typeof (body as Record<string, unknown>).title === 'string'
  ) {
    return body as TargetWindowIdentity;
  }
  return INVALID_TARGET;
}
