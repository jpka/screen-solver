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
import type { SolveLoop } from '../../src/host/solve/loop.ts';
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
