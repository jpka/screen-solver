import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type { CaptureSessionCoordinator } from '../../src/host/capture/session-coordinator.ts';
import type { CapturedFrame } from '../../src/host/capture/types.ts';
import { loadConfigStore, type ConfigStore } from '../../src/host/config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity, WindowInfo } from '../../src/host/config/types.ts';
import { createHostRoutes, type HostRoutesDeps } from '../../src/host/http/routes.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import { silentLogger } from '../../src/host/logger.ts';
import type { Provider, SolveEvent, SolveImage } from '../../src/host/provider/types.ts';
import type { SolveOutcome } from '../../src/host/solve/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

const TARGET: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };

const GOOD_FRAME: CapturedFrame = {
  mediaType: 'image/jpeg',
  bytes: new Uint8Array([1, 2, 3]),
  width: 1200,
  height: 800,
  quality: 'ok',
};

const BLACK_FRAME: CapturedFrame = { ...GOOD_FRAME, quality: 'black-or-empty' };

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

/** A `CaptureSessionCoordinator` stand-in whose `captureFrame()` behavior a test controls directly. */
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

/**
 * A `Provider` whose `solve()` calls are driven by hand -- each call gets its
 * own pushable queue, so a test can script `delta`/`done`/`error` at whatever
 * pace it wants, and can tell when a given call has actually started via
 * {@link FakeProvider.waitForCall}. Matches the ticket's own suggestion
 * ("driven by manually-resolved promises or an async generator you can push
 * into").
 */
interface FakeProvider {
  readonly provider: Provider;
  readonly calls: ScriptedCall[];
  /** Resolves once the Nth (1-indexed) call to `solve()` has happened. */
  waitForCall(n: number): Promise<ScriptedCall>;
}

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

interface Harness {
  readonly server: ListeningHttpServer;
  readonly configStore: ConfigStore;
  readonly fakeProvider: FakeProvider;
  readonly outcomes: SolveOutcome[];
  setFrame(frame: CapturedFrame | null): void;
  setMinimized(minimized: boolean): void;
  setPresent(present: boolean): void;
}

async function startTestServer(
  t: TestContext,
  overrides: Partial<HostRoutesDeps> & { target?: TargetWindowIdentity | null } = {},
): Promise<Harness> {
  let present = true;
  let minimized = false;
  let frame: CapturedFrame | null = GOOD_FRAME;

  const enumerateWindows: EnumerateWindows = async (): Promise<readonly WindowInfo[]> =>
    present ? [TARGET] : [];

  const configStore = await loadConfigStore({ stateRoot: await tempStateRoot(t), enumerateWindows });
  const target = overrides.target === undefined ? TARGET : overrides.target;
  if (target !== null) await configStore.setTargetWindow(target);

  const provider = fakeProvider();
  const outcomes: SolveOutcome[] = [];

  const captureSessionCoordinator = fakeCaptureCoordinator(async () => frame);

  const routes = createHostRoutes({
    configStore,
    captureSessionCoordinator,
    provider: provider.provider,
    enumerateWindows,
    isTargetMinimized: async () => minimized,
    onOutcome: (event) => {
      outcomes.push(event.outcome);
    },
    logger: silentLogger,
    ...overrides,
  });

  const server = await startHttpServer({ binding: { host: '127.0.0.1', port: 0 }, routes, logger: silentLogger });
  t.after(() => server.close());

  return {
    server,
    configStore,
    fakeProvider: provider,
    outcomes,
    setFrame: (next) => {
      frame = next;
    },
    setMinimized: (next) => {
      minimized = next;
    },
    setPresent: (next) => {
      present = next;
    },
  };
}

interface ParsedFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Reads SSE frames off an already-open `fetch` response body, one `data:` payload per frame. */
function frameReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    /** Reads exactly `count` frames, in order. */
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
    /** Races one more frame against a timeout; resolves `'timeout'` if none arrives, proving silence. */
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

describe('POST /solve + GET /events', () => {
  it('rejects with 400 and no SSE traffic when no target window is configured', async (t) => {
    const h = await startTestServer(t, { target: null });
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'no_target_configured' });

    assert.equal(h.fakeProvider.calls.length, 0);
    const frame = await events.raceTimeout(150);
    assert.equal(frame, 'timeout', 'no SSE traffic follows a rejected solve');
  });

  it('answers 503 when the routes were constructed without solve-loop dependencies wired', async (t) => {
    const routes = createHostRoutes();
    const server = await startHttpServer({
      binding: { host: '127.0.0.1', port: 0 },
      routes,
      logger: silentLogger,
    });
    t.after(() => server.close());

    const response = await fetch(`${server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'not_ready' });
  });

  it('accepts with 202, then streams start -> delta* -> done{usage} to a connected client', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    assert.deepEqual(call.image, { mediaType: GOOD_FRAME.mediaType, bytes: GOOD_FRAME.bytes });

    call.push({ type: 'delta', text: '# Two Sum\n' });
    call.push({ type: 'delta', text: '```js\ncode\n```' });
    call.push({
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      stopReason: 'end_turn',
    });

    const frames = await events.take(4);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['start', 'delta', 'delta', 'done'],
    );
    assert.equal(frames[1]?.text, '# Two Sum\n');
    assert.equal(frames[2]?.text, '```js\ncode\n```');
    assert.deepEqual(frames[3]?.usage, {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    assert.equal(h.outcomes.length, 1);
    assert.equal(h.outcomes[0]?.type, 'done');
    if (h.outcomes[0]?.type === 'done') {
      assert.equal(h.outcomes[0].text, '# Two Sum\n```js\ncode\n```');
    }
  });

  it('interrupts a solve still streaming, marking it interrupted internally with no dangling SSE traffic', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const first = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(first.status, 202);
    const call1 = await h.fakeProvider.waitForCall(1);
    call1.push({ type: 'delta', text: 'partial answer' });
    // Make sure the first delta actually lands on the wire before interrupting.
    const [startFrame, deltaFrame] = await events.take(2);
    assert.equal(startFrame?.type, 'start');
    assert.equal(deltaFrame?.type, 'delta');

    const second = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(second.status, 202);
    const call2 = await h.fakeProvider.waitForCall(2);
    assert.notEqual(call1.signal, call2.signal);
    assert.equal(call1.signal?.aborted, true, 'the first attempt is aborted synchronously with the second 202');

    call2.push({ type: 'delta', text: 'fresh answer' });
    call2.push({
      type: 'done',
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      stopReason: 'end_turn',
    });

    const rest = await events.take(3);
    assert.deepEqual(
      rest.map((f) => f.type),
      ['start', 'delta', 'done'],
      'a fresh start begins immediately; nothing is left visibly dangling on the wire',
    );
    assert.equal(rest[1]?.text, 'fresh answer');

    // The interrupted outcome is internal-only -- never on the SSE wire.
    assert.equal(h.outcomes.length, 2);
    assert.equal(h.outcomes[0]?.type, 'interrupted');
    if (h.outcomes[0]?.type === 'interrupted') {
      assert.equal(h.outcomes[0].text, 'partial answer');
    }
    assert.equal(h.outcomes[1]?.type, 'done');
  });

  it('is a silent no-spend when the target is minimized: no SSE event, no provider call', async (t) => {
    const checked = deferred<void>();
    const h = await startTestServer(t, {
      isTargetMinimized: async () => {
        checked.resolve();
        return true;
      },
    });
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202, 'the guard runs after the 202, not before');

    await checked.promise;
    await flush();

    assert.equal(h.fakeProvider.calls.length, 0, 'a minimized target never reaches the provider');
    assert.equal(h.outcomes.length, 0, 'no internal outcome for a guard failure either');

    const frame = await events.raceTimeout(150);
    assert.equal(frame, 'timeout', 'no SSE traffic at all');
  });

  it('is a silent no-spend on a black/zero-size frame: no SSE event, no provider call', async (t) => {
    const captured = deferred<void>();
    let callCount = 0;
    const h = await startTestServer(t, {
      captureSessionCoordinator: fakeCaptureCoordinator(async () => {
        callCount += 1;
        captured.resolve();
        return BLACK_FRAME;
      }),
    });
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    await captured.promise;
    await flush();

    assert.equal(callCount, 1, 'precondition: the guard actually ran');
    assert.equal(h.fakeProvider.calls.length, 0, 'a black frame never reaches the provider');
    assert.equal(h.outcomes.length, 0);

    const frame = await events.raceTimeout(150);
    assert.equal(frame, 'timeout');
  });

  it('is a silent no-spend when the target has vanished from enumeration', async (t) => {
    const h = await startTestServer(t);
    h.setPresent(false);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    await flush();

    assert.equal(h.fakeProvider.calls.length, 0);
    assert.equal(h.outcomes.length, 0);
    const frame = await events.raceTimeout(150);
    assert.equal(frame, 'timeout');
  });

  it('delivers a provider error{kind} to the wire as a terminal event', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'delta', text: 'partial' });
    call.push({ type: 'error', kind: 'transient', message: 'the provider gave up' });

    const frames = await events.take(3);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['start', 'delta', 'error'],
    );
    assert.equal(frames[2]?.kind, 'transient');

    assert.equal(h.outcomes.length, 1);
    assert.equal(h.outcomes[0]?.type, 'error');
    if (h.outcomes[0]?.type === 'error') {
      assert.equal(h.outcomes[0].kind, 'transient');
      assert.equal(h.outcomes[0].text, 'partial');
    }
  });

  it('fans the identical event sequence out to two simultaneous /events connections', async (t) => {
    const h = await startTestServer(t);
    const clientA = await connectEvents(`${h.server.url}/events`);
    const clientB = await connectEvents(`${h.server.url}/events`);
    t.after(() => clientA.cancel());
    t.after(() => clientB.cancel());

    const response = await fetch(`${h.server.url}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const call = await h.fakeProvider.waitForCall(1);
    call.push({ type: 'delta', text: 'hello' });
    call.push({
      type: 'done',
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      stopReason: 'end_turn',
    });

    const [framesA, framesB] = await Promise.all([clientA.take(3), clientB.take(3)]);
    assert.deepEqual(framesA, framesB);
    assert.deepEqual(
      framesA.map((f) => f.type),
      ['start', 'delta', 'done'],
    );
  });
});
