import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import type { CaptureSessionCoordinator } from '../../src/host/capture/session-coordinator.ts';
import type { CapturedFrame } from '../../src/host/capture/types.ts';
import { loadConfigStore } from '../../src/host/config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity, WindowInfo } from '../../src/host/config/types.ts';
import { createHostRoutes, type HostRoutesDeps } from '../../src/host/http/routes.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import { silentLogger } from '../../src/host/logger.ts';
import { ANSWER_LOG_FILE_NAME, createAnswerLog } from '../../src/host/logs/answer-log.ts';
import { createSolveLogRecorder } from '../../src/host/logs/recorder.ts';
import type { AnswerLogEntry, UsageLogEntry } from '../../src/host/logs/types.ts';
import { createUsageLog, USAGE_LOG_FILE_NAME } from '../../src/host/logs/usage-log.ts';
import type { Provider, SolveEvent, SolveImage } from '../../src/host/provider/types.ts';
import type { SolveOutcomeEvent } from '../../src/host/solve/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

const TARGET: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };
const MODEL = 'fake-model';

const GOOD_FRAME: CapturedFrame = {
  mediaType: 'image/jpeg',
  bytes: new Uint8Array([1, 2, 3]),
  width: 1200,
  height: 800,
  quality: 'ok',
};

const USAGE = { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** Reads a JSONL file straight off disk, bypassing `AnswerLog`/`UsageLog` -- the point is to assert on what actually landed on disk, not on the module that wrote it. */
async function readJsonlLines<T>(path: string): Promise<T[]> {
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

function fakeCaptureCoordinator(captureFrame: () => Promise<CapturedFrame | null>): CaptureSessionCoordinator {
  return {
    currentTarget: () => TARGET,
    captureFrame,
    settled: async () => {},
    stop: async () => {},
  };
}

interface ScriptedCall {
  readonly image: SolveImage;
  readonly signal: AbortSignal | undefined;
  push(event: SolveEvent): void;
}

interface FakeProvider {
  readonly provider: Provider;
  waitForCall(n: number): Promise<ScriptedCall>;
}

/** Trimmed down from `solve-http.test.ts`'s own `fakeProvider` -- same shape, only what this suite needs. */
function fakeProvider(): FakeProvider {
  const calls: ScriptedCall[] = [];
  const waiters = new Map<number, (call: ScriptedCall) => void>();

  const provider: Provider = {
    model: MODEL,
    solve(image, options) {
      const queue: SolveEvent[] = [];
      let notify: (() => void) | null = null;

      const call: ScriptedCall = {
        image,
        signal: options?.signal,
        push(event) {
          queue.push(event);
          const wake = notify;
          notify = null;
          wake?.();
        },
      };
      calls.push(call);
      waiters.get(calls.length)?.(call);

      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<SolveEvent>> {
              for (;;) {
                if (options?.signal?.aborted === true) {
                  return { value: undefined, done: true };
                }
                if (queue.length > 0) {
                  return { value: queue.shift() as SolveEvent, done: false };
                }
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
    waitForCall(n) {
      const existing = calls[n - 1];
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.set(n, resolve));
    },
  };
}

interface ParsedFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Adapted from `solve-http.test.ts`'s own SSE frame reader, with one fix:
 * `take()` now drains whatever's already sitting in `buffer` *before*
 * blocking on a fresh `reader.read()`, rather than always reading first. The
 * original always called `reader.read()` unconditionally at the top of its
 * loop -- harmless as long as every `take(n)` call asks for exactly the
 * frames a single chunk contains, but this suite's sync tests push two
 * frames back-to-back with no work in between (`start` immediately followed
 * by `done`), which can arrive in one underlying chunk. A `take(1)` call
 * consuming only the first frame left the second sitting unparsed in
 * `buffer`; a *second* `take(1)` call then blocked forever waiting for new
 * bytes that were never coming, since the real data was already sitting in
 * memory. Draining the buffer first closes that gap.
 */
function frameReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function drainBuffered(events: ParsedFrame[], count: number): void {
    let idx: number;
    while (events.length < count && (idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine !== undefined) {
        events.push(JSON.parse(dataLine.slice('data: '.length)) as ParsedFrame);
      }
    }
  }

  return {
    async take(count: number): Promise<ParsedFrame[]> {
      const events: ParsedFrame[] = [];
      drainBuffered(events, count);
      while (events.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        drainBuffered(events, count);
      }
      return events;
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => {});
    },
  };
}

async function connectEvents(url: string): Promise<ReturnType<typeof frameReader>> {
  const response = await fetch(url);
  return frameReader(response);
}

interface Harness {
  readonly server: ListeningHttpServer;
  readonly stateRoot: string;
  readonly fakeProvider: FakeProvider;
  setFrame(frame: CapturedFrame | null): void;
  /** Resolves once at least `n` `onOutcome`-triggered `record()` calls have finished -- i.e. their JSONL writes have landed on disk. */
  waitForRecordCount(n: number): Promise<void>;
}

async function startTestServer(
  t: TestContext,
  overrides: Partial<HostRoutesDeps> = {},
): Promise<Harness> {
  const stateRoot = await tempStateRoot(t);
  let frame: CapturedFrame | null = GOOD_FRAME;

  const enumerateWindows: EnumerateWindows = async (): Promise<readonly WindowInfo[]> => [TARGET];
  const configStore = await loadConfigStore({ stateRoot, enumerateWindows });
  await configStore.setTargetWindow(TARGET);

  const provider = fakeProvider();
  const captureSessionCoordinator = fakeCaptureCoordinator(async () => frame);

  const answerLog = createAnswerLog({ stateRoot });
  const usageLog = createUsageLog({ stateRoot });
  const recorder = createSolveLogRecorder({ answerLog, usageLog, logger: silentLogger });

  let recordedCount = 0;
  // Each waiter only resolves once `recordedCount` actually reaches its own
  // threshold -- earlier code here spliced out (and discarded) every waiter
  // on *any* increment regardless of whether its threshold was met, which
  // silently dropped a `waitForRecordCount(2)` call still waiting after the
  // first of two increments and hung the test forever. Kept until satisfied.
  const waiters: Array<{ readonly threshold: number; readonly resolve: () => void }> = [];
  const onOutcome = async (event: SolveOutcomeEvent): Promise<void> => {
    await recorder.record(event);
    recordedCount += 1;
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (recordedCount >= waiters[i]!.threshold) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };

  const routes = createHostRoutes({
    configStore,
    captureSessionCoordinator,
    provider: provider.provider,
    enumerateWindows,
    isTargetMinimized: async () => false,
    onOutcome,
    answerLog,
    logger: silentLogger,
    ...overrides,
  });

  const server = await startHttpServer({ binding: { host: '127.0.0.1', port: 0 }, routes, logger: silentLogger });
  t.after(() => server.close());

  return {
    server,
    stateRoot,
    fakeProvider: provider,
    setFrame: (next) => {
      frame = next;
    },
    waitForRecordCount(n) {
      if (recordedCount >= n) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push({ threshold: n, resolve });
      });
    },
  };
}

describe('answers.jsonl / usage.jsonl', () => {
  it('a successful (non-bail) done solve appends exactly one answers.jsonl entry with all fields, and one usage.jsonl entry', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'delta', text: '# Two Sum\n' });
    call.push({ type: 'delta', text: '```js\ncode\n```\nExplanation.' });
    call.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });

    await events.take(4);
    await h.waitForRecordCount(1);

    const answers = await readJsonlLines<AnswerLogEntry>(join(h.stateRoot, ANSWER_LOG_FILE_NAME));
    assert.equal(answers.length, 1);
    const entry = answers[0]!;
    assert.equal(entry.title, 'Two Sum');
    assert.equal(entry.text, '# Two Sum\n```js\ncode\n```\nExplanation.');
    assert.equal(entry.model, MODEL);
    assert.deepEqual(entry.usage, USAGE);
    assert.deepEqual(entry.target, TARGET);
    assert.equal(entry.interrupted, undefined);
    assert.equal(typeof entry.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp)), 'timestamp parses as a real date');

    const usageEntries = await readJsonlLines<UsageLogEntry>(join(h.stateRoot, USAGE_LOG_FILE_NAME));
    assert.equal(usageEntries.length, 1);
    assert.equal(usageEntries[0]?.outcome, 'done');
    assert.deepEqual(usageEntries[0]?.usage, USAGE);
    assert.equal(usageEntries[0]?.bail, undefined);
    assert.deepEqual(usageEntries[0]?.target, TARGET);
  });

  it('an interrupted solve appends one answers.jsonl entry tagged interrupted:true, plus its own usage.jsonl entry', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const first = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(first.status, 202);
    const call1 = await h.fakeProvider.waitForCall(1);
    call1.push({ type: 'delta', text: '# Partial Problem\nsome partial answer' });
    await events.take(2); // start, delta

    const second = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(second.status, 202);
    const call2 = await h.fakeProvider.waitForCall(2);
    call2.push({ type: 'delta', text: '# Full Problem\nthe full answer' });
    call2.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });
    await events.take(3); // start, delta, done

    await h.waitForRecordCount(2);

    const answers = await readJsonlLines<AnswerLogEntry>(join(h.stateRoot, ANSWER_LOG_FILE_NAME));
    assert.equal(answers.length, 2);
    const interruptedEntry = answers[0]!;
    assert.equal(interruptedEntry.interrupted, true);
    assert.equal(interruptedEntry.title, 'Partial Problem');
    assert.equal(interruptedEntry.text, '# Partial Problem\nsome partial answer');
    assert.deepEqual(interruptedEntry.usage, ZERO_USAGE, 'no real usage exists for an interrupted attempt');
    assert.deepEqual(interruptedEntry.target, TARGET);

    const doneEntry = answers[1]!;
    assert.equal(doneEntry.interrupted, undefined);
    assert.equal(doneEntry.title, 'Full Problem');

    const usageEntries = await readJsonlLines<UsageLogEntry>(join(h.stateRoot, USAGE_LOG_FILE_NAME));
    assert.equal(usageEntries.length, 2);
    assert.equal(usageEntries[0]?.outcome, 'interrupted');
    assert.deepEqual(usageEntries[0]?.usage, ZERO_USAGE);
    assert.equal(usageEntries[1]?.outcome, 'done');
    assert.deepEqual(usageEntries[1]?.usage, USAGE);
  });

  it('a bail (# No exercise on screen) appends a usage.jsonl entry but no answers.jsonl entry', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'delta', text: '# No exercise on screen\n' });
    call.push({ type: 'delta', text: 'Nothing to solve here.' });
    call.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });

    await events.take(4);
    await h.waitForRecordCount(1);

    const answers = await readJsonlLines<AnswerLogEntry>(join(h.stateRoot, ANSWER_LOG_FILE_NAME));
    assert.equal(answers.length, 0, 'a bail never gets an answers.jsonl entry');

    const usageEntries = await readJsonlLines<UsageLogEntry>(join(h.stateRoot, USAGE_LOG_FILE_NAME));
    assert.equal(usageEntries.length, 1, 'a bail still spends a call and is recorded in usage.jsonl');
    assert.equal(usageEntries[0]?.outcome, 'done');
    assert.equal(usageEntries[0]?.bail, true);
    assert.deepEqual(usageEntries[0]?.usage, USAGE, 'a bail has real usage -- the provider really was called');
  });

  it('a failed solve (error) appends a usage.jsonl entry but no answers.jsonl entry', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'delta', text: 'partial' });
    call.push({ type: 'error', kind: 'transient', message: 'the provider gave up' });

    await events.take(3); // start, delta, error
    await h.waitForRecordCount(1);

    const answers = await readJsonlLines<AnswerLogEntry>(join(h.stateRoot, ANSWER_LOG_FILE_NAME));
    assert.equal(answers.length, 0, 'a failed solve never gets an answers.jsonl entry');

    const usageEntries = await readJsonlLines<UsageLogEntry>(join(h.stateRoot, USAGE_LOG_FILE_NAME));
    assert.equal(usageEntries.length, 1);
    assert.equal(usageEntries[0]?.outcome, 'error');
    assert.equal(usageEntries[0]?.errorKind, 'transient');
    assert.deepEqual(usageEntries[0]?.usage, ZERO_USAGE, 'no real usage exists for a failed attempt');
  });

  it('GET /answers returns the full current backlog as JSON, matching answers.jsonl', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call1 = await h.fakeProvider.waitForCall(1);
    call1.push({ type: 'delta', text: '# First\ncode one' });
    call1.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });
    await events.take(3);
    await h.waitForRecordCount(1);

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call2 = await h.fakeProvider.waitForCall(2);
    call2.push({ type: 'delta', text: '# Second\ncode two' });
    call2.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });
    await events.take(3);
    await h.waitForRecordCount(2);

    const response = await fetch(`${h.server.url}/answers`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as AnswerLogEntry[];

    const fileContents = await readJsonlLines<AnswerLogEntry>(join(h.stateRoot, ANSWER_LOG_FILE_NAME));
    assert.deepEqual(body, fileContents);
    assert.equal(body.length, 2);
    assert.equal(body[0]?.title, 'First');
    assert.equal(body[1]?.title, 'Second');
  });

  it('GET /answers answers an empty array when no answers have been recorded yet', async (t) => {
    const h = await startTestServer(t);
    const response = await fetch(`${h.server.url}/answers`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });
});

describe('GET /events sync{text} mid-flight join', () => {
  it('a client connecting mid-solve receives sync{text} carrying the accumulated text so far, not start', async (t) => {
    const h = await startTestServer(t);
    const firstClient = await connectEvents(`${h.server.url}/events`);
    t.after(() => firstClient.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'delta', text: '# Two Sum\n' });
    call.push({ type: 'delta', text: 'partial code' });

    // Make sure both deltas have actually landed on the wire before a second client joins.
    const firstFrames = await firstClient.take(3);
    assert.deepEqual(
      firstFrames.map((f) => f.type),
      ['start', 'delta', 'delta'],
    );

    const lateClient = await connectEvents(`${h.server.url}/events`);
    t.after(() => lateClient.cancel());

    const [syncFrame] = await lateClient.take(1);
    assert.equal(syncFrame?.type, 'sync');
    assert.equal(syncFrame?.text, '# Two Sum\npartial code');

    // Finish the solve and drain the terminal frame on *both* clients before
    // the test ends -- `lateClient` is still a regular subscriber after its
    // `sync` catch-up (it goes on to receive the same broadcasts everyone
    // else does), so leaving its `done` frame unread when `t.after` cancels
    // the connection races stream cancellation against the server's own
    // forced-close (`closeAllConnections()`); draining it first keeps
    // cleanup uneventful, the same way the existing dual-client fan-out test
    // in `solve-http.test.ts` always drains before cancelling.
    call.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });
    const [doneFrame] = await firstClient.take(1);
    assert.equal(doneFrame?.type, 'done');
    const [lateDoneFrame] = await lateClient.take(1);
    assert.equal(lateDoneFrame?.type, 'done');

    // Also wait for the resulting background JSONL write to finish -- not
    // asserted on here, but otherwise the temp state root's own `t.after`
    // cleanup (registered inside `tempStateRoot`, so it runs *after* this
    // test's own `t.after` hooks) can race an in-progress `fs.appendFile`
    // and fail to remove the directory.
    await h.waitForRecordCount(1);
  });

  it('a client connecting when nothing is in flight receives no sync and simply waits for the next start', async (t) => {
    const h = await startTestServer(t);
    const client = await connectEvents(`${h.server.url}/events`);
    t.after(() => client.cancel());

    // The proof this client got no `sync` catch-up *is* that the first frame
    // it ever receives, once a solve actually happens, is `start` -- a
    // separate "assert total silence first" probe on this same connection
    // isn't needed, and (unlike `solve-http.test.ts`'s `raceTimeout`, not
    // reproduced in this file) would be actively unsafe: a losing race's
    // abandoned `take(1)` call stays pending against the reader and would
    // silently steal the real `start` frame the moment it arrives, starving
    // the `take(1)` below forever. `raceTimeout` is only safe to use when
    // nothing reads from that connection again afterward.
    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);
    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });

    const [frame] = await client.take(1);
    assert.equal(frame?.type, 'start', 'the first frame this client ever sees is a real start, not sync');
    await client.take(1); // done -- drained so nothing is left pending when t.after cancels this connection
    await h.waitForRecordCount(1); // see the previous test's comment on why this matters for cleanup
  });

  it('a fresh connection after a solve has already finished also gets no sync, and waits for the next start', async (t) => {
    const h = await startTestServer(t);
    const firstClientEvents = await connectEvents(`${h.server.url}/events`);
    t.after(() => firstClientEvents.cancel());

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call1 = await h.fakeProvider.waitForCall(1);
    call1.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });
    await firstClientEvents.take(2); // start, done

    // Nothing in flight now -- a client connecting at this point must not
    // see a sync. Proven the same way as the previous test: the first frame
    // this connection ever receives is `start`, not `sync` -- no separate
    // `raceTimeout` silence probe here, since (as the previous test's
    // comment explains) that would leave a stray pending read racing the
    // real `take(1)` below for the same frame.
    const lateClient = await connectEvents(`${h.server.url}/events`);
    t.after(() => lateClient.cancel());

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call2 = await h.fakeProvider.waitForCall(2);
    call2.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });

    // Drain both clients fully before the test ends -- see the previous
    // test's comment for why an unread pending frame at cancel time is worth
    // avoiding.
    const [frame] = await lateClient.take(1);
    assert.equal(frame?.type, 'start');
    await lateClient.take(1); // done
    await firstClientEvents.take(2); // start, done -- the second solve, broadcast to every subscriber
    await h.waitForRecordCount(2); // both solves' background writes -- see the first test's comment on why
  });
});
