import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_KEY_ENV_VAR } from '../../src/host/api-key.ts';
import type {
  AudioChunkSink,
  OpenAudioCapture,
  Transcriber,
  TranscriberStream,
  TranscriptChannel,
  TranscriptEvent,
} from '../../src/host/audio/types.ts';
import { HTTP_HOST_ENV_VAR, HTTP_PORT_ENV_VAR } from '../../src/host/binding.ts';
import { bootstrapHost, type HostRuntime, type StartedHost } from '../../src/host/bootstrap.ts';
import type { CapturedFrame, CaptureSession, TargetWindowIdentity } from '../../src/host/capture/types.ts';
import type { WindowInfo } from '../../src/host/config/types.ts';
import type { Logger } from '../../src/host/logger.ts';
import { ANSWER_LOG_FILE_NAME } from '../../src/host/logs/answer-log.ts';
import { TRANSCRIPT_LOG_FILE_NAME } from '../../src/host/logs/transcript-log.ts';
import type { AnswerLogEntry, TranscriptEntry, UsageLogEntry } from '../../src/host/logs/types.ts';
import { USAGE_LOG_FILE_NAME } from '../../src/host/logs/usage-log.ts';
import type {
  Provider,
  SolveEvent,
  SolveImage,
  SolveOptions,
  Usage,
} from '../../src/host/provider/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * The shared rig for the end-to-end suites (#25's "Testing Decisions",
 * "Primary seam: the local HTTP server").
 *
 * What makes these e2e rather than another round of route-level integration
 * tests: they boot the *whole assembled host* through `bootstrapHost` -- the
 * real config store over a real `config.json`, the real solve loop, the real
 * capture-session coordinator, the real `answers.jsonl`/`usage.jsonl`
 * recorder, the real static-asset serving of `static/client/` -- and drive it
 * only the way a browser can: `GET /`, `GET /config`, `GET /windows`,
 * `POST /config/target`, `POST /solve`, `GET /events`, `GET /answers`. The
 * existing `test/host/*` suites wire `createHostRoutes` by hand and assert on
 * one seam at a time; nothing there proves `bootstrap.ts` connects them to
 * each other correctly, which is exactly what a spec-level check needs.
 *
 * Only the boundaries the spec itself declares un-unit-testable are faked, and
 * each is faked at the same injection point production uses:
 *
 * - `enumerateWindows` — real one shells out to `Get-Process` + `desktopCapturer`.
 * - `isTargetMinimized` — real one P/Invokes `IsIconic`.
 * - `openCaptureSession` — real one drives the hidden renderer's WGC pipeline.
 * - `provider` — real one calls Anthropic over the network.
 * - `openAudioCapture` — real one is Windows render-loopback through the hidden renderer.
 * - `transcriber` — real one holds a Deepgram WebSocket open.
 *
 * Everything on this side of those six is the real code path, files on disk
 * included.
 */

export const API_KEY = 'sk-ant-e2e-not-a-real-key';
const LOOPBACK = '127.0.0.1';

export const LEETCODE_WINDOW: TargetWindowIdentity = {
  processName: 'chrome.exe',
  title: 'Two Sum - LeetCode',
};

export const EXERCISM_WINDOW: TargetWindowIdentity = {
  processName: 'msedge.exe',
  title: 'Reverse String | Exercism',
};

export const GOOD_FRAME: CapturedFrame = {
  mediaType: 'image/jpeg',
  bytes: new Uint8Array([137, 80, 78, 71]),
  width: 1568,
  height: 900,
  quality: 'ok',
};

/** What a minimized or off-virtual-desktop window's capture actually looks like: a successful grab of nothing. */
export const BLACK_FRAME: CapturedFrame = { ...GOOD_FRAME, quality: 'black-or-empty' };

export const USAGE: Usage = {
  inputTokens: 1350,
  outputTokens: 280,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 1196,
};

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** `static/client/`, resolved from this file rather than `src/main/paths.ts` — that module documents itself as Electron-side only, tests included. */
const WEB_CLIENT_DIR = fileURLToPath(new URL('../../static/client/', import.meta.url));

/* -------------------------------------------------------------------------- */
/* Counters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A call counter a test can await a threshold on.
 *
 * `POST /solve` answers `202` before any of the pre-flight work runs, so a
 * test asserting "this solve spent nothing" needs a way to know the guard it
 * expects to fire has actually fired -- otherwise it's asserting on a solve
 * that simply hasn't started yet. Every faked boundary increments one of
 * these, so tests wait on a real signal instead of a sleep.
 */
export interface Counter {
  count(): number;
  waitFor(n: number): Promise<void>;
}

interface MutableCounter extends Counter {
  increment(): void;
}

function createCounter(): MutableCounter {
  let value = 0;
  const waiters: Array<{ threshold: number; resolve: () => void }> = [];

  return {
    count: () => value,
    increment() {
      value += 1;
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (value >= waiters[i]!.threshold) {
          waiters[i]!.resolve();
          waiters.splice(i, 1);
        }
      }
    },
    waitFor(n) {
      if (value >= n) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push({ threshold: n, resolve });
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fake provider                                                               */
/* -------------------------------------------------------------------------- */

/** One in-progress `Provider.solve()` call, driven by hand from the test. */
export interface ScriptedCall {
  /** `null` for a spoken-only solve, where no screenshot was captured at all. */
  readonly image: SolveImage | null;
  /**
   * The whole options object the loop passed, `undefined` if it passed none.
   *
   * Kept alongside `signal` rather than replacing it: the difference between
   * "no transcript" and "a transcript that happens to be undefined" is the
   * thing `POST /solve` promises (`solve-with-transcript.test.ts`), and only
   * the raw object can be asked whether the key is there at all.
   */
  readonly options: SolveOptions | undefined;
  readonly signal: AbortSignal | undefined;
  /** Pushes one raw event into this call's stream. */
  push(event: SolveEvent): void;
  /** The common case: stream `text` as a single delta, then a successful `done`. */
  answer(text: string, usage?: Usage): void;
  /** Terminate this call with a provider error of the given kind. */
  fail(kind: 'auth' | 'refusal' | 'transient', message?: string): void;
}

export interface FakeProvider {
  readonly provider: Provider;
  readonly calls: readonly ScriptedCall[];
  /** Resolves once the Nth (1-indexed) `solve()` call has started. */
  waitForCall(n: number): Promise<ScriptedCall>;
}

/**
 * Same hand-driven shape the `test/host` suites already use -- each `solve()`
 * call gets its own pushable queue, and aborting ends the iterable quietly
 * with no terminal event, per the provider seam's documented contract
 * (`src/host/provider/types.ts`).
 */
export function createFakeProvider(model: string): FakeProvider {
  const calls: ScriptedCall[] = [];
  const waiters = new Map<number, (call: ScriptedCall) => void>();

  const provider: Provider = {
    model,
    solve(image, options) {
      const queue: SolveEvent[] = [];
      let notify: (() => void) | null = null;

      const wake = (): void => {
        const resume = notify;
        notify = null;
        resume?.();
      };

      const call: ScriptedCall = {
        image,
        options,
        signal: options?.signal,
        push(event) {
          queue.push(event);
          wake();
        },
        answer(text, usage = USAGE) {
          call.push({ type: 'delta', text });
          call.push({ type: 'done', usage, stopReason: 'end_turn' });
        },
        fail(kind, message = `fake ${kind} failure`) {
          call.push({ type: 'error', kind, message });
        },
      };
      calls.push(call);
      waiters.get(calls.length)?.(call);

      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<SolveEvent>> {
              for (;;) {
                if (options?.signal?.aborted === true) return { value: undefined, done: true };
                if (queue.length > 0) return { value: queue.shift() as SolveEvent, done: false };
                await new Promise<void>((resolve) => {
                  notify = resolve;
                  options?.signal?.addEventListener('abort', () => resolve(), { once: true });
                });
              }
            },
          };
        },
      };
    },
  };

  return {
    provider,
    calls,
    waitForCall(n) {
      const existing = calls[n - 1];
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.set(n, resolve));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fake transcription                                                          */
/* -------------------------------------------------------------------------- */

/** One open transcription stream, driven by hand the way `ScriptedCall` drives one provider call. */
export interface ScriptedStream {
  readonly channel: TranscriptChannel;
  /** Every PCM chunk the recording coordinator routed to this channel, in order. */
  readonly chunks: readonly Uint8Array[];
  /** Pushes one event as though it had arrived off the socket. */
  emit(event: TranscriptEvent): void;
  readonly closed: boolean;
}

export interface FakeTranscriber {
  readonly transcriber: Transcriber;
  readonly streams: readonly ScriptedStream[];
  /** The stream the current recording session is using, or a failure saying nothing is recording. */
  current(): ScriptedStream;
}

/**
 * A transcriber whose sockets open the moment they are asked to.
 *
 * Reporting `open` synchronously from `open()` is what makes
 * `app.startRecording()` leave the coordinator in `'on'` rather than
 * `'starting'`, so a test can say "recording is on, now speak" without racing
 * a state machine. A real Deepgram socket takes a network round trip to get
 * there; nothing downstream of `RecordingCoordinator` can tell the difference,
 * and `test/host/recording-coordinator.test.ts` is where the slow-open and
 * never-opens paths are actually exercised.
 */
export function createFakeTranscriber(model: string): FakeTranscriber {
  const streams: ScriptedStream[] = [];

  const transcriber: Transcriber = {
    model,
    open({ channel, onEvent }) {
      const chunks: Uint8Array[] = [];
      let closed = false;

      const stream: ScriptedStream & TranscriberStream = {
        channel,
        chunks,
        emit: onEvent,
        get closed() {
          return closed;
        },
        send(pcm) {
          chunks.push(pcm);
        },
        async close() {
          closed = true;
        },
      };

      streams.push(stream);
      onEvent({ type: 'open' });
      return stream;
    },
  };

  return {
    transcriber,
    streams,
    current() {
      const open = streams.findLast((stream) => !stream.closed);
      if (open === undefined) {
        throw new Error('precondition: no transcription stream is open -- call startRecording() first');
      }
      return open;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* SSE client                                                                  */
/* -------------------------------------------------------------------------- */

export interface SseFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface SseClient {
  /** Reads exactly `count` frames, in order. */
  take(count: number): Promise<SseFrame[]>;
  /**
   * Races one more frame against a timeout, resolving `'timeout'` if none
   * arrives. Only safe on a connection nothing reads from again afterwards:
   * a losing race leaves a pending read that would steal a later frame.
   */
  raceTimeout(ms: number): Promise<'timeout' | SseFrame>;
  cancel(): Promise<void>;
}

/**
 * Reads SSE frames off an open `fetch` body.
 *
 * Drains whatever is already buffered before issuing a fresh `read()`: the
 * server can put several frames into one physical chunk (`error` immediately
 * followed by `status`, say), and a reader that always read first would block
 * forever on bytes that already arrived.
 */
function frameReader(response: Response): SseClient {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function drainBuffered(events: SseFrame[], count: number): void {
    let idx: number;
    while (events.length < count && (idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine !== undefined) {
        events.push(JSON.parse(dataLine.slice('data: '.length)) as SseFrame);
      }
    }
  }

  const client: SseClient = {
    async take(count) {
      const events: SseFrame[] = [];
      drainBuffered(events, count);
      while (events.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        drainBuffered(events, count);
      }
      return events;
    },
    async raceTimeout(ms) {
      return Promise.race([
        client.take(1).then((frames) => frames[0] ?? ('timeout' as const)),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
      ]);
    },
    async cancel() {
      await reader.cancel().catch(() => {});
    },
  };

  return client;
}

/* -------------------------------------------------------------------------- */
/* The app under test                                                          */
/* -------------------------------------------------------------------------- */

export interface BootOptions {
  /** Reuse an existing state root -- how the restart tests simulate a second run against the same `%APPDATA%`. */
  readonly stateRoot?: string;
  /** What window enumeration reports. Defaults to both fixture windows being open. */
  readonly windows?: readonly WindowInfo[];
  /** Serve `static/client/` at `/`, the way `src/main/index.ts` does. Defaults to true. */
  readonly serveWebClient?: boolean;
  readonly model?: string;
  /** Replaces the whole environment block, for the startup-refusal tests. */
  readonly env?: NodeJS.ProcessEnv;
  readonly acquireInstanceLock?: () => boolean;
  readonly transcriptionModel?: string;
  /** Wire the audio seams at all. `false` is "no Deepgram key" -- the recording toggle then reports `'unavailable'`. Defaults to true. */
  readonly recording?: boolean;
}

/** What `GET`/`POST /recording` answer with. */
export interface RecordingBody {
  readonly state: string;
  readonly sessionId: string | null;
  readonly revision: number;
}

/** How long one `say()` line is assumed to take, when the caller doesn't say. */
const SPOKEN_LINE_SECONDS = 4;

export interface E2EApp {
  readonly url: string;
  readonly stateRoot: string;
  readonly host: StartedHost;
  /** The environment block the host was started from -- the API key is deleted out of it during startup. */
  readonly env: NodeJS.ProcessEnv;
  readonly provider: FakeProvider;
  readonly model: string;
  readonly transcription: FakeTranscriber;
  readonly transcriptionModel: string;
  /** Every line the host printed, in order -- the "one console line" surface of the status ladder. */
  readonly consoleLines: readonly string[];

  /** Windows the fake `openCaptureSession` was asked to open, in order. */
  readonly sessionsOpened: readonly TargetWindowIdentity[];
  readonly sessionsClosed: Counter;
  readonly enumerations: Counter;
  readonly minimizedChecks: Counter;
  readonly frameGrabs: Counter;
  readonly audioCapturesOpened: Counter;
  readonly audioCapturesClosed: Counter;

  setWindows(windows: readonly WindowInfo[]): void;
  /**
   * What consecutive `enumerateWindows()` calls report, one entry per call;
   * the last entry repeats forever. How a test spells "gone on the first
   * check, back on the re-check" without racing a timer against the guard.
   */
  setWindowsSequence(sequence: readonly (readonly WindowInfo[])[]): void;
  setMinimized(minimized: boolean): void;
  setFrame(frame: CapturedFrame): void;

  /* The web client's whole vocabulary, and nothing else. */
  solve(): Promise<Response>;
  /** The second solve button: the same request, plus whatever is in the transcript window. */
  solveWithTranscript(): Promise<Response>;
  /**
   * The third solve button: recent speech and no screenshot at all -- no
   * target window is required for this one, since nothing is captured.
   */
  solveTranscriptOnly(): Promise<Response>;
  getConfig(): Promise<{ targetWindow: TargetWindowIdentity | null; revision: number }>;
  listWindows(): Promise<WindowInfo[]>;
  setTarget(target: TargetWindowIdentity | null): Promise<Response>;
  getAnswers(): Promise<AnswerLogEntry[]>;
  getTranscript(limit?: number): Promise<TranscriptEntry[]>;
  getRecording(): Promise<RecordingBody>;
  startRecording(): Promise<RecordingBody>;
  stopRecording(): Promise<RecordingBody>;
  connect(t: TestContext): Promise<SseClient>;

  /**
   * Says one line out loud, as a *final* transcript segment on the recording
   * session currently open.
   *
   * This is the honest place to inject speech into an e2e run: the text
   * enters at the transcription seam, exactly where a real Deepgram socket
   * would put it, and everything downstream -- `transcript.jsonl`, the
   * bounded window `POST /solve/with-transcript` reads, the SSE frame every
   * client gets -- is the real code path. `startSeconds`/`endSeconds` default
   * to a simple advancing cursor; a caller with its own timeline (the mock
   * quiz's `atSeconds`) passes them.
   */
  say(text: string, span?: { readonly startSeconds: number; readonly endSeconds: number }): void;
  /** Pushes one block of PCM through the fake capture device, the way the hidden renderer would. */
  pushAudio(pcm?: Uint8Array, channel?: TranscriptChannel): void;

  /* What actually landed on disk. */
  readAnswerLog(): Promise<AnswerLogEntry[]>;
  readUsageLog(): Promise<UsageLogEntry[]>;
  readTranscriptLog(): Promise<TranscriptEntry[]>;
  waitForAnswerLines(n: number): Promise<AnswerLogEntry[]>;
  waitForUsageLines(n: number): Promise<UsageLogEntry[]>;
  waitForTranscriptLines(n: number): Promise<TranscriptEntry[]>;

  shutdown(): Promise<void>;
}

/**
 * Boots the real host and hands back everything a test needs to drive it.
 *
 * Registers its own shutdown with `t.after`, and does so *after*
 * `tempStateRoot` has registered its cleanup, so (hooks running last-registered
 * first) the server is down before the directory is removed.
 */
export async function bootApp(t: TestContext, options: BootOptions = {}): Promise<E2EApp> {
  const stateRoot = options.stateRoot ?? (await tempStateRoot(t));
  const model = options.model ?? 'fake-vision-model';

  let windowSequence: readonly (readonly WindowInfo[])[] = [
    options.windows ?? [LEETCODE_WINDOW, EXERCISM_WINDOW],
  ];
  let sequenceBase = 0;
  let minimized = false;
  let frame: CapturedFrame = GOOD_FRAME;

  const sessionsOpened: TargetWindowIdentity[] = [];
  const sessionsClosed = createCounter();
  const enumerations = createCounter();
  const minimizedChecks = createCounter();
  const frameGrabs = createCounter();
  const audioCapturesOpened = createCounter();
  const audioCapturesClosed = createCounter();

  const consoleLines: string[] = [];
  const logger: Logger = {
    info: (message) => void consoleLines.push(message),
    warn: (message) => void consoleLines.push(message),
    error: (message) => void consoleLines.push(message),
  };

  const provider = createFakeProvider(model);

  const transcriptionModel = options.transcriptionModel ?? 'fake-transcription-model';
  const transcription = createFakeTranscriber(transcriptionModel);
  /** The sink the recording session handed the capture device, or `null` while nothing is recording. */
  let audioSink: AudioChunkSink | null = null;
  /** Where `say()` places the next line when the caller doesn't say, reset per recording session. */
  let spokenSeconds = 0;

  const openAudioCapture: OpenAudioCapture = async (sink) => {
    audioSink = sink;
    audioCapturesOpened.increment();
    return {
      close: async () => {
        audioSink = null;
        audioCapturesClosed.increment();
      },
    };
  };

  const env: NodeJS.ProcessEnv = options.env ?? {
    [API_KEY_ENV_VAR]: API_KEY,
    [HTTP_HOST_ENV_VAR]: LOOPBACK,
    [HTTP_PORT_ENV_VAR]: '0',
  };

  const runtime: HostRuntime = {
    env,
    stateRoot,
    acquireInstanceLock: options.acquireInstanceLock ?? (() => true),
    logger,
    enumerateWindows: async () => {
      // Indexed from wherever the sequence was installed, not from process
      // start, so a test's "gone, then back" reads as calls 1 and 2 of *its*
      // sequence regardless of how many enumerations startup already spent.
      const index = Math.min(enumerations.count() - sequenceBase, windowSequence.length - 1);
      enumerations.increment();
      return windowSequence[Math.max(index, 0)] ?? [];
    },
    isTargetMinimized: async () => {
      minimizedChecks.increment();
      return minimized;
    },
    openCaptureSession: async (target): Promise<CaptureSession> => {
      sessionsOpened.push(target);
      return {
        captureFrame: async () => {
          frameGrabs.increment();
          return frame;
        },
        close: async () => {
          sessionsClosed.increment();
        },
      };
    },
    provider: provider.provider,
    clientStaticDir: options.serveWebClient === false ? undefined : WEB_CLIENT_DIR,
    // Always wired, unlike `clientStaticDir`: an app whose recording toggle
    // reports `'unavailable'` is a differently-configured app, and this
    // harness's job is the fully assembled one. A suite that doesn't care
    // simply never presses the toggle, and no audio ever flows.
    transcriber: options.recording === false ? undefined : transcription.transcriber,
    openAudioCapture: options.recording === false ? undefined : openAudioCapture,
  };

  const result = await bootstrapHost(runtime);
  if (result.status !== 'started') {
    throw new Error('precondition: the e2e harness expects bootstrapHost to start the app');
  }
  const host = result.host;

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await host.shutdown();
  };
  t.after(shutdown);

  const url = `http://${LOOPBACK}:${host.binding.port}`;

  const app: E2EApp = {
    url,
    stateRoot,
    host,
    env,
    provider,
    model,
    transcription,
    transcriptionModel,
    consoleLines,
    sessionsOpened,
    sessionsClosed,
    enumerations,
    minimizedChecks,
    frameGrabs,
    audioCapturesOpened,
    audioCapturesClosed,

    setWindows: (next) => {
      windowSequence = [next];
      sequenceBase = enumerations.count();
    },
    setWindowsSequence: (sequence) => {
      windowSequence = sequence.length > 0 ? sequence : [[]];
      sequenceBase = enumerations.count();
    },
    setMinimized: (next) => {
      minimized = next;
    },
    setFrame: (next) => {
      frame = next;
    },

    solve: () => fetch(`${url}/solve`, { method: 'POST' }),
    solveWithTranscript: () => fetch(`${url}/solve/with-transcript`, { method: 'POST' }),
    solveTranscriptOnly: () => fetch(`${url}/solve/transcript-only`, { method: 'POST' }),
    async getConfig() {
      const response = await fetch(`${url}/config`);
      return (await response.json()) as { targetWindow: TargetWindowIdentity | null; revision: number };
    },
    async listWindows() {
      const response = await fetch(`${url}/windows`);
      return (await response.json()) as WindowInfo[];
    },
    setTarget: (target) =>
      fetch(`${url}/config/target`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target),
      }),
    async getAnswers() {
      const response = await fetch(`${url}/answers`);
      return (await response.json()) as AnswerLogEntry[];
    },
    async getTranscript(limit) {
      const query = limit === undefined ? '' : `?limit=${limit}`;
      const response = await fetch(`${url}/transcript${query}`);
      return (await response.json()) as TranscriptEntry[];
    },
    async getRecording() {
      const response = await fetch(`${url}/recording`);
      return (await response.json()) as RecordingBody;
    },
    async startRecording() {
      const body = await setRecording(url, true);
      // A fresh session's transcript offsets start at zero, the same way a
      // fresh socket's do.
      spokenSeconds = 0;
      return body;
    },
    stopRecording: () => setRecording(url, false),

    say(text, span) {
      const startSeconds = span?.startSeconds ?? spokenSeconds;
      const endSeconds = span?.endSeconds ?? startSeconds + SPOKEN_LINE_SECONDS;
      spokenSeconds = Math.max(spokenSeconds, endSeconds);
      transcription.current().emit({ type: 'final', text, startSeconds, endSeconds });
    },
    pushAudio(pcm = new Uint8Array([0, 0, 0, 0]), channel = 'them') {
      if (audioSink === null) {
        throw new Error('precondition: no audio capture is open -- call startRecording() first');
      }
      audioSink({ channel, pcm });
    },

    async connect(testContext) {
      const response = await fetch(`${url}/events`);
      const client = frameReader(response);
      testContext.after(() => client.cancel());
      return client;
    },

    readAnswerLog: () => readJsonl<AnswerLogEntry>(join(stateRoot, ANSWER_LOG_FILE_NAME)),
    readUsageLog: () => readJsonl<UsageLogEntry>(join(stateRoot, USAGE_LOG_FILE_NAME)),
    readTranscriptLog: () => readJsonl<TranscriptEntry>(join(stateRoot, TRANSCRIPT_LOG_FILE_NAME)),
    waitForAnswerLines: (n) =>
      waitForLines(join(stateRoot, ANSWER_LOG_FILE_NAME), n, ANSWER_LOG_FILE_NAME),
    waitForUsageLines: (n) => waitForLines(join(stateRoot, USAGE_LOG_FILE_NAME), n, USAGE_LOG_FILE_NAME),
    waitForTranscriptLines: (n) =>
      waitForLines(join(stateRoot, TRANSCRIPT_LOG_FILE_NAME), n, TRANSCRIPT_LOG_FILE_NAME),

    shutdown,
  };

  return app;
}

/** `POST /recording {on}` -- the toggle both `startRecording` and `stopRecording` press. */
async function setRecording(url: string, on: boolean): Promise<RecordingBody> {
  const response = await fetch(`${url}/recording`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on }),
  });
  return (await response.json()) as RecordingBody;
}

/* -------------------------------------------------------------------------- */
/* Disk helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Reads a JSONL file straight off disk -- the point is what landed there, not what the writing module thinks it wrote. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

const LINE_WAIT_TIMEOUT_MS = 2_000;

/**
 * Polls a JSONL file until it holds at least `n` lines.
 *
 * The terminal SSE frame is broadcast *before* the outcome bus writes its
 * line (`solve/loop.ts`), and the host exposes no "the write finished" signal
 * to an HTTP client -- which is the whole point: a client can't observe it
 * either. Polling is the honest way to wait for something only the filesystem
 * can confirm.
 */
export async function waitForLines<T>(path: string, n: number, label: string): Promise<T[]> {
  const deadline = Date.now() + LINE_WAIT_TIMEOUT_MS;
  for (;;) {
    const lines = await readJsonl<T>(path);
    if (lines.length >= n) return lines;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${n} line(s) in ${label}; saw ${lines.length}.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** Polls until `predicate` holds, or fails the test with `description`. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = LINE_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** A couple of macrotask hops -- enough for an already-reached point in the guard chain to finish unwinding. */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
