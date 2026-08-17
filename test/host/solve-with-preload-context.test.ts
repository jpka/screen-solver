import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createTranscriptWindow, type TranscriptWindow } from '../../src/host/audio/window.ts';
import type { CaptureSessionCoordinator } from '../../src/host/capture/session-coordinator.ts';
import type { CapturedFrame } from '../../src/host/capture/types.ts';
import { loadConfigStore } from '../../src/host/config/store.ts';
import type { TargetWindowIdentity } from '../../src/host/config/types.ts';
import type { PreloadContextReader } from '../../src/host/context/preload-context.ts';
import { createHostRoutes } from '../../src/host/http/routes.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import { silentLogger } from '../../src/host/logger.ts';
import type { Provider, SolveOptions } from '../../src/host/provider/types.ts';
import { createEventBroadcaster, type EventBroadcaster } from '../../src/host/solve/broadcaster.ts';
import { startSolveLoop, type SolveLoop } from '../../src/host/solve/loop.ts';
import type { SolveOutcomeEvent } from '../../src/host/solve/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * Preloaded context is meant to ride along regardless of solve mode -- it is
 * background, not a per-request thing the client decides to send. This
 * exercises `preloadContextReader` actually reaching the provider through all
 * three routes, and the outcome bus tagging that honestly.
 */

const TARGET: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };

const GOOD_FRAME: CapturedFrame = {
  mediaType: 'image/jpeg',
  bytes: new Uint8Array([1, 2, 3]),
  width: 1200,
  height: 800,
  quality: 'ok',
};

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
} as const;

function captureCoordinator(): CaptureSessionCoordinator {
  return {
    currentTarget: () => TARGET,
    captureFrame: async () => GOOD_FRAME,
    settled: async () => {},
    stop: async () => {},
  };
}

function fixedReader(text: string | null): PreloadContextReader {
  return { read: async () => text };
}

interface Harness {
  readonly server: ListeningHttpServer;
  readonly solveLoop: SolveLoop;
  readonly window: TranscriptWindow;
  readonly options: SolveOptions[];
  readonly outcomes: SolveOutcomeEvent[];
}

async function startTestServer(
  t: TestContext,
  options: { preloadContextReader?: PreloadContextReader } = {},
): Promise<Harness> {
  const seen: SolveOptions[] = [];
  const outcomes: SolveOutcomeEvent[] = [];
  const window = createTranscriptWindow();

  const provider: Provider = {
    model: 'fake-model',
    // eslint-disable-next-line require-yield
    async *solve(_image, solveOptions = {}) {
      seen.push(solveOptions);
      yield { type: 'done', usage: ZERO_USAGE, stopReason: 'end_turn' } as const;
    },
  };

  const configStore = await loadConfigStore({
    stateRoot: await tempStateRoot(t),
    enumerateWindows: async () => [TARGET],
  });
  await configStore.setTargetWindow(TARGET);

  const { routes, solveLoop } = createHostRoutes({
    configStore,
    captureSessionCoordinator: captureCoordinator(),
    provider,
    enumerateWindows: async () => [TARGET],
    transcriptWindow: window,
    preloadContextReader: options.preloadContextReader,
    onOutcome: (event) => void outcomes.push(event),
    logger: silentLogger,
  });
  assert.ok(solveLoop !== null);

  const server = await startHttpServer({
    binding: { host: '127.0.0.1', port: 0 },
    routes,
    logger: silentLogger,
  });
  t.after(() => server.close());

  return { server, solveLoop, window, options: seen, outcomes };
}

describe('preloaded context reaching the provider', () => {
  it('is absent when no reader is wired at all', async (t) => {
    const h = await startTestServer(t);

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.options[0]?.preloadContext, undefined);
    assert.equal('preloadContext' in (h.options[0] ?? {}), false, 'the key is absent, not undefined');
  });

  it('is absent when the reader resolves null', async (t) => {
    const h = await startTestServer(t, { preloadContextReader: fixedReader(null) });

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal('preloadContext' in (h.options[0] ?? {}), false);
  });

  it('reaches the provider on the plain screen route', async (t) => {
    const h = await startTestServer(t, { preloadContextReader: fixedReader('notes on this site') });

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.options[0]?.preloadContext, 'notes on this site');
  });

  it('reaches the provider on the screen-with-transcript route, alongside the transcript', async (t) => {
    const h = await startTestServer(t, { preloadContextReader: fixedReader('notes on this site') });
    h.window.add({
      recordingSessionId: 's1',
      channel: 'them',
      text: 'a hint',
      timestamp: new Date().toISOString(),
      startSeconds: 0,
      endSeconds: 1,
      model: 'nova-3',
    });

    await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.options[0]?.preloadContext, 'notes on this site');
    assert.equal(h.options[0]?.transcript, 'Them: a hint');
  });

  it('reaches the provider on the spoken-only route, which has no screen at all', async (t) => {
    const h = await startTestServer(t, { preloadContextReader: fixedReader('notes on this site') });
    h.window.add({
      recordingSessionId: 's1',
      channel: 'them',
      text: 'what is the time complexity',
      timestamp: new Date().toISOString(),
      startSeconds: 0,
      endSeconds: 1,
      model: 'nova-3',
    });

    await fetch(`${h.server.url}/solve/transcript-only`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.options[0]?.preloadContext, 'notes on this site');
  });

  it('tags the outcome bus with withPreloadContext only when content was actually sent', async (t) => {
    const withContext = await startTestServer(t, { preloadContextReader: fixedReader('notes') });
    await fetch(`${withContext.server.url}/solve`, { method: 'POST' });
    await withContext.solveLoop.settled();
    assert.equal(withContext.outcomes[0]?.withPreloadContext, true);

    const without = await startTestServer(t, { preloadContextReader: fixedReader(null) });
    await fetch(`${without.server.url}/solve`, { method: 'POST' });
    await without.solveLoop.settled();
    assert.equal(without.outcomes[0]?.withPreloadContext, undefined);
  });

  it('is independent of withTranscript -- both can be tagged on the same outcome', async (t) => {
    const h = await startTestServer(t, { preloadContextReader: fixedReader('notes') });
    h.window.add({
      recordingSessionId: 's1',
      channel: 'them',
      text: 'a hint',
      timestamp: new Date().toISOString(),
      startSeconds: 0,
      endSeconds: 1,
      model: 'nova-3',
    });

    await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.outcomes[0]?.withPreloadContext, true);
    assert.equal(h.outcomes[0]?.withTranscript, true);
  });
});

describe('GET /config', () => {
  it('reports the configured contextPath', async (t) => {
    const stateRoot = await tempStateRoot(t);
    // No live setter for contextPath (see its doc comment) -- write config.json
    // directly to simulate what a user hand-editing it before startup produces.
    await writeFile(
      join(stateRoot, 'config.json'),
      JSON.stringify({ targetWindow: null, provider: null, contextPath: '/notes' }),
    );
    const configStore = await loadConfigStore({ stateRoot, enumerateWindows: async () => [] });

    const { routes } = createHostRoutes({ configStore });
    const server = await startHttpServer({
      binding: { host: '127.0.0.1', port: 0 },
      routes,
      logger: silentLogger,
    });
    t.after(() => server.close());

    const response = await fetch(`${server.url}/config`);
    const body = (await response.json()) as { contextPath: string | null };
    assert.equal(body.contextPath, '/notes');
  });
});

/**
 * A `preloadContextReader.read()` whose call N doesn't resolve until the test
 * says so, and whose call N is itself only observable once the loop has
 * actually reached it (`waitForCall`) -- what a review-fix regression test for
 * an abort landing mid-read needs, and something `fixedReader` above (a
 * reader that always resolves immediately) cannot express.
 */
function deferredReader(): {
  readonly reader: PreloadContextReader;
  resolveCall(n: number, text: string | null): void;
  waitForCall(n: number): Promise<void>;
} {
  const resolvers: Array<(text: string | null) => void> = [];
  const waiters = new Map<number, () => void>();

  return {
    reader: {
      read(): Promise<string | null> {
        return new Promise((resolve) => {
          resolvers.push(resolve);
          waiters.get(resolvers.length)?.();
        });
      },
    },
    resolveCall(n, text) {
      resolvers[n - 1]?.(text);
    },
    waitForCall(n) {
      if (resolvers.length >= n) return Promise.resolve();
      return new Promise((resolve) => waiters.set(n, resolve));
    },
  };
}

describe('an abort landing while preloadContextReader.read() is still pending', () => {
  it('never starts the broadcaster or calls the provider for the superseded attempt, and reports no outcome for it at all', async (t) => {
    // Review fix: `callProvider` used to call `broadcaster.start()`
    // unconditionally right after this await, with no re-check of `signal`.
    // A second `trigger()` landing while the first attempt's read() was still
    // pending would abort that first attempt's signal *during* the await, and
    // execution would resume straight into `broadcaster.start()` for an
    // attempt already known to be dead -- the provider then ends quietly for
    // the aborted signal, and the `interrupted` branch never calls
    // `broadcaster.done()` / `.error()` to close out the `start` that had
    // just gone out, leaving a connected client stuck showing "in flight".
    const pre = deferredReader();

    const realBroadcaster = createEventBroadcaster();
    let startCalls = 0;
    const broadcaster: EventBroadcaster = {
      ...realBroadcaster,
      start: () => {
        startCalls += 1;
        realBroadcaster.start();
      },
    };

    let providerCalls = 0;
    const provider: Provider = {
      model: 'fake-model',
      async *solve() {
        providerCalls += 1;
        yield { type: 'done', usage: ZERO_USAGE, stopReason: 'end_turn' } as const;
      },
    };

    const outcomes: SolveOutcomeEvent[] = [];
    const configStore = await loadConfigStore({
      stateRoot: await tempStateRoot(t),
      enumerateWindows: async () => [TARGET],
    });
    await configStore.setTargetWindow(TARGET);

    const loop = startSolveLoop({
      configStore,
      captureSessionCoordinator: captureCoordinator(),
      provider,
      broadcaster,
      enumerateWindows: async () => [TARGET],
      isTargetMinimized: async () => false,
      preloadContextReader: pre.reader,
      onOutcome: (event) => void outcomes.push(event),
      logger: silentLogger,
    });
    t.after(() => loop.stop());

    assert.equal(loop.trigger(), true, 'attempt 1');
    await pre.waitForCall(1);

    assert.equal(loop.trigger(), true, 'attempt 2, supersedes and aborts attempt 1');
    pre.resolveCall(1, 'ignored -- attempt 1 is already aborted by the time this resumes');
    await pre.waitForCall(2);
    pre.resolveCall(2, null);

    await loop.settled();
    await loop.stop();

    assert.equal(startCalls, 1, 'the broadcaster is started exactly once, for attempt 2 only');
    assert.equal(providerCalls, 1, 'the provider is called exactly once, for attempt 2 only');
    assert.equal(outcomes.length, 1, 'attempt 1 produced no outcome at all -- the same total silence any other pre-commit guard failure produces');
    assert.equal(outcomes[0]?.outcome.type, 'done');
  });
});
