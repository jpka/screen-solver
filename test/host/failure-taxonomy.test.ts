import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { createTargetIntentTracker, type TargetIntentTracker } from '../../src/host/capture/intent.ts';
import type { CaptureSessionCoordinator } from '../../src/host/capture/session-coordinator.ts';
import type { CapturedFrame } from '../../src/host/capture/types.ts';
import { loadConfigStore, type ConfigStore } from '../../src/host/config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity, WindowInfo } from '../../src/host/config/types.ts';
import { createHostRoutes, type HostRoutesDeps } from '../../src/host/http/routes.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import type { Logger } from '../../src/host/logger.ts';
import type { Provider, SolveEvent, SolveImage } from '../../src/host/provider/types.ts';
import type { SolveLoop } from '../../src/host/solve/loop.ts';
import type { SolveOutcome } from '../../src/host/solve/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * Ticket #32's own test surface: the standing status pill's escalation
 * ladder over SSE, and the mid-run target-loss re-resolution-then-fallback
 * flow, exercised the same way `solve-http.test.ts` exercises #29 -- real
 * HTTP/SSE against fakes, asserting on wire events and (here) on
 * `ConfigStore`'s live state, never on internal call graphs.
 *
 * The other rows of #32's failure-taxonomy table are already covered
 * elsewhere and are not duplicated here:
 * - Silent no-spend (vanished/minimized/black-frame) -- `solve-http.test.ts`.
 * - Bail (`# No exercise on screen`) -- `answer-usage-logs.test.ts`.
 * - Port-bind failure -- `http-server.test.ts` / `bootstrap.test.ts`.
 * - The renderer-crash escalation ladder -- `capture-crash-restart-policy.test.ts`
 *   unit-tests the pure decision; actually wiring `render-process-gone` to a
 *   real hidden `BrowserWindow` needs a real renderer process and stays
 *   manual/E2E-verified, the same limitation `minimized-check.ts` already
 *   carries for its own Windows-only mechanism (see that file's own doc
 *   comment) -- #32's own acceptance criteria explicitly sanction exactly
 *   this kind of documented manual step.
 */

const TARGET: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };

const GOOD_FRAME: CapturedFrame = {
  mediaType: 'image/jpeg',
  bytes: new Uint8Array([1, 2, 3]),
  width: 1200,
  height: 800,
  quality: 'ok',
};

const USAGE = { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** A deferred promise, for synchronizing a test with a specific point inside the guard chain -- no arbitrary sleeps. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A couple of microtask/macrotask hops -- enough for a guard chain of a few awaited fakes to finish running past a point a test already knows it reached. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
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
  readonly calls: ScriptedCall[];
  waitForCall(n: number): Promise<ScriptedCall>;
}

/** Same shape as `solve-http.test.ts`'s own `fakeProvider` -- see that file for the fuller doc comment. */
function fakeProvider(): FakeProvider {
  const calls: ScriptedCall[] = [];
  const waiters = new Map<number, (call: ScriptedCall) => void>();

  const provider: Provider = {
    model: 'fake-model',
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
    calls,
    waitForCall(n) {
      const existing = calls[n - 1];
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.set(n, resolve));
    },
  };
}

interface LoggedLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
}

/** Captures every logger call, split by level, in call order -- lets a test assert exactly how many (and which) console lines a status transition produced. */
function fakeLogger(): Logger & { readonly lines: readonly LoggedLine[] } {
  const lines: LoggedLine[] = [];
  return {
    lines,
    info(message) {
      lines.push({ level: 'info', message });
    },
    warn(message) {
      lines.push({ level: 'warn', message });
    },
    error(message) {
      lines.push({ level: 'error', message });
    },
  };
}

interface Harness {
  readonly server: ListeningHttpServer;
  readonly configStore: ConfigStore;
  readonly fakeProvider: FakeProvider;
  readonly outcomes: SolveOutcome[];
  readonly solveLoop: SolveLoop;
  readonly targetIntent: TargetIntentTracker;
  readonly logger: Logger & { readonly lines: readonly LoggedLine[] };
  setFrame(frame: CapturedFrame | null): void;
  /** Controls what consecutive `enumerateWindows()` calls report present/vanished -- the last entry repeats for any call past the end of the array. */
  setPresentSequence(sequence: readonly boolean[]): void;
  enumerateCallCount(): number;
}

async function startTestServer(
  t: TestContext,
  overrides: Partial<HostRoutesDeps> & { target?: TargetWindowIdentity | null } = {},
): Promise<Harness> {
  let presentSequence: readonly boolean[] = [true];
  let enumerateCalls = 0;
  let frame: CapturedFrame | null = GOOD_FRAME;

  const enumerateWindows: EnumerateWindows = async (): Promise<readonly WindowInfo[]> => {
    const index = Math.min(enumerateCalls, presentSequence.length - 1);
    const present = presentSequence[index] ?? true;
    enumerateCalls += 1;
    return present ? [TARGET] : [];
  };

  const configStore = await loadConfigStore({ stateRoot: await tempStateRoot(t), enumerateWindows });
  const target = overrides.target === undefined ? TARGET : overrides.target;
  if (target !== null) await configStore.setTargetWindow(target);

  const provider = fakeProvider();
  const outcomes: SolveOutcome[] = [];
  const targetIntent = overrides.targetIntent ?? createTargetIntentTracker();
  const logger = overrides.logger ?? fakeLogger();

  const captureSessionCoordinator = fakeCaptureCoordinator(async () => frame);

  const { routes, solveLoop } = createHostRoutes({
    configStore,
    captureSessionCoordinator,
    provider: provider.provider,
    enumerateWindows,
    isTargetMinimized: async () => false,
    targetIntent,
    onOutcome: (event) => {
      outcomes.push(event.outcome);
    },
    logger,
    ...overrides,
  });

  const server = await startHttpServer({ binding: { host: '127.0.0.1', port: 0 }, routes, logger: logger });
  t.after(() => server.close());

  assert.ok(solveLoop !== null, 'precondition: the harness always wires the solve loop');

  return {
    server,
    configStore,
    fakeProvider: provider,
    outcomes,
    solveLoop,
    targetIntent,
    logger: logger as Logger & { readonly lines: readonly LoggedLine[] },
    setFrame: (next) => {
      frame = next;
    },
    setPresentSequence: (sequence) => {
      presentSequence = sequence;
    },
    enumerateCallCount: () => enumerateCalls,
  };
}

interface ParsedFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Reads SSE frames off an already-open `fetch` response body, one `data:` payload per frame. Same helper as `solve-http.test.ts`. */
function frameReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async take(count: number): Promise<ParsedFrame[]> {
      const events: ParsedFrame[] = [];
      while (events.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine !== undefined) {
            events.push(JSON.parse(dataLine.slice('data: '.length)) as ParsedFrame);
            if (events.length >= count) break;
          }
        }
      }
      return events;
    },
    async raceTimeout(ms: number): Promise<'timeout' | ParsedFrame> {
      const result = await Promise.race([
        this.take(1).then((frames) => frames[0] ?? ('timeout' as const)),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
      ]);
      return result;
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

describe('#32 failure taxonomy: standing status pill', () => {
  it('an auth rejection produces error{kind:"auth"} on the wire, flips the pill sticky, and prints exactly one console line', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'delta', text: 'partial' });
    call.push({ type: 'error', kind: 'auth', message: 'key revoked' });

    const frames = await events.take(4);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['start', 'delta', 'error', 'status'],
    );
    assert.equal(frames[2]?.kind, 'auth');
    assert.deepEqual(
      { level: frames[3]?.level, kind: frames[3]?.kind },
      { level: 'sticky', kind: 'auth' },
    );

    const errorLines = h.logger.lines.filter((l) => l.level === 'error' && l.message.startsWith('status:'));
    assert.equal(errorLines.length, 1, 'exactly one console line for the sticky transition');
  });

  it('stays sticky across a subsequent unrelated solve (another auth error): no duplicate status frame, no duplicate console line', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call1 = await h.fakeProvider.waitForCall(1);
    call1.push({ type: 'error', kind: 'auth', message: 'key revoked' });
    // Consumed in one `take()`, not two -- `frameReader.take()` (like
    // `solve-http.test.ts`'s own copy) always issues at least one fresh
    // `reader.read()` before looking at whatever it already buffered, so a
    // second, separate `take()` call right after this one would block
    // waiting on network bytes that were already sitting in its buffer.
    await events.take(3); // start, error, status{sticky}

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call2 = await h.fakeProvider.waitForCall(2);
    call2.push({ type: 'error', kind: 'auth', message: 'key still revoked' });

    const frames = await events.take(2);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['start', 'error'],
      'no second status frame follows the second auth error -- the pill was already sticky',
    );

    await flush();
    const statusErrorLines = h.logger.lines.filter((l) => l.level === 'error' && l.message.startsWith('status:'));
    assert.equal(statusErrorLines.length, 1, 'still exactly one sticky console line total');
  });

  it('an auth-caused sticky status resolves back to silent on the next successful solve -- "explicitly resolved"', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call1 = await h.fakeProvider.waitForCall(1);
    call1.push({ type: 'error', kind: 'auth', message: 'key revoked' });
    await events.take(3); // start, error, status{sticky}

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call2 = await h.fakeProvider.waitForCall(2);
    call2.push({ type: 'delta', text: '# Two Sum\n' });
    call2.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });

    const frames = await events.take(4);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['start', 'delta', 'done', 'status'],
    );
    assert.deepEqual({ level: frames[3]?.level, kind: frames[3]?.kind }, { level: 'silent', kind: null });
  });

  it('a transient failure with retries exhausted produces error{kind:"transient"} and escalates to auto-recovering, not sticky -- no console line', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'error', kind: 'transient', message: 'retries exhausted' });

    const frames = await events.take(3);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['start', 'error', 'status'],
    );
    assert.equal(frames[1]?.kind, 'transient');
    assert.deepEqual({ level: frames[2]?.level, kind: frames[2]?.kind }, { level: 'auto-recovering', kind: 'transient' });

    const errorLines = h.logger.lines.filter((l) => l.level === 'error' && l.message.startsWith('status:'));
    assert.equal(errorLines.length, 0, 'auto-recovering is not sticky and must not print a console line');
  });

  it('a mid-stream error leaves the already-streamed partial text visible to a connected client, with the terminal error frame appended', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'delta', text: '# Two Sum\n' });
    call.push({ type: 'delta', text: 'partial code before the connection dropped' });
    call.push({ type: 'error', kind: 'transient', message: 'connection dropped mid-stream' });

    const frames = await events.take(4);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['start', 'delta', 'delta', 'error'],
      'nothing already streamed vanishes -- the terminal error is appended after it, not in place of it',
    );
    assert.equal(frames[1]?.text, '# Two Sum\n');
    assert.equal(frames[2]?.text, 'partial code before the connection dropped');

    assert.equal(h.outcomes.length, 1);
    assert.equal(h.outcomes[0]?.type, 'error');
    if (h.outcomes[0]?.type === 'error') {
      assert.equal(
        h.outcomes[0].text,
        '# Two Sum\npartial code before the connection dropped',
        'the partial text is preserved on the internal outcome bus too -- available to #31 persistence, not just the live wire',
      );
    }
  });

  it('a client that connects after a sticky transition immediately learns the current status, not just future clients', async (t) => {
    const h = await startTestServer(t);

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'error', kind: 'auth', message: 'key revoked' });
    await flush();

    const lateEvents = await connectEvents(`${h.server.url}/events`);
    t.after(() => lateEvents.cancel());

    const [first] = await lateEvents.take(1);
    assert.deepEqual(
      { type: first?.type, level: first?.level, kind: first?.kind },
      { type: 'status', level: 'sticky', kind: 'auth' },
      'a freshly-connecting client is caught up on an ongoing sticky status immediately, without waiting for the next failure',
    );
  });
});

describe('#32 failure taxonomy: mid-run target loss', () => {
  it('an unexpected loss (both checks vanished) triggers exactly one re-resolution attempt, spends no call, then falls back to the picker', async (t) => {
    const h = await startTestServer(t);
    h.setPresentSequence([false, false]);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    // `flush()`'s couple of microtask hops aren't enough here: the fallback
    // path awaits a real `config.json` write (`ConfigStore.setTargetWindow`
    // against the temp state root), which is real disk I/O, not just queued
    // promise callbacks. `solveLoop.settled()` waits for the attempt --
    // write included -- to actually finish.
    await h.solveLoop.settled();
    await flush();

    assert.equal(h.fakeProvider.calls.length, 0, 'no call was ever spent (spec table: "N/A")');
    assert.equal(h.outcomes.length, 0);
    assert.equal(
      h.enumerateCallCount(),
      2,
      'exactly one re-resolution attempt beyond the first check before giving up',
    );
    assert.equal(
      h.configStore.get().targetWindow,
      null,
      'fell back to the picker by clearing the configured target',
    );

    const frame = await events.raceTimeout(150);
    assert.equal(frame, 'timeout', 'the fallback is a config change, not SSE traffic');
  });

  it('a re-resolved target (vanished once, found again) proceeds silently -- no fallback, the solve still happens', async (t) => {
    const h = await startTestServer(t);
    h.setPresentSequence([false, true]);

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });
    await flush();

    assert.equal(h.fakeProvider.calls.length, 1, 'the re-resolved target still gets to spend a call');
    assert.deepEqual(
      h.configStore.get().targetWindow,
      TARGET,
      'the target was never cleared -- the re-resolution recovered it silently',
    );
  });

  it('a deliberate pause ignores a vanished target entirely: no re-resolution attempt, no fallback', async (t) => {
    const h = await startTestServer(t);
    h.targetIntent.pause();
    h.setPresentSequence([false, false]);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    await flush();

    assert.equal(h.fakeProvider.calls.length, 0);
    assert.equal(h.outcomes.length, 0);
    assert.equal(h.enumerateCallCount(), 1, 'paused: not even the one re-resolution attempt runs');
    assert.deepEqual(
      h.configStore.get().targetWindow,
      TARGET,
      'the target is left exactly as configured -- a deliberate pause never triggers the fallback',
    );

    const frame = await events.raceTimeout(150);
    assert.equal(frame, 'timeout');
  });

  it('resume() after a pause restores the unexpected-loss flow', async (t) => {
    const h = await startTestServer(t);
    h.targetIntent.pause();
    h.targetIntent.resume();
    h.setPresentSequence([false, false]);

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);
    await h.solveLoop.settled();
    await flush();

    assert.equal(h.configStore.get().targetWindow, null, 'resumed: the normal fallback-to-picker flow applies again');
  });
});
