import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { createTranscriptWindow, type TranscriptWindow } from '../../src/host/audio/window.ts';
import type { CaptureSessionCoordinator } from '../../src/host/capture/session-coordinator.ts';
import type { CapturedFrame } from '../../src/host/capture/types.ts';
import { loadConfigStore } from '../../src/host/config/store.ts';
import type { TargetWindowIdentity } from '../../src/host/config/types.ts';
import { createHostRoutes } from '../../src/host/http/routes.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import type { TranscriptEntry } from '../../src/host/logs/types.ts';
import { silentLogger } from '../../src/host/logger.ts';
import type { Provider, SolveOptions } from '../../src/host/provider/types.ts';
import type { SolveLoop } from '../../src/host/solve/loop.ts';
import type { SolveOutcomeEvent } from '../../src/host/solve/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * `POST /solve/with-transcript` -- and, just as importantly, the guard that
 * `POST /solve` still sends no transcript at all. The two routes come from one
 * factory in `routes.ts`, so the risk worth testing is not that they diverge
 * in status codes but that the plain one quietly starts carrying speech.
 */

const TARGET: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };

const GOOD_FRAME: CapturedFrame = {
  mediaType: 'image/jpeg',
  bytes: new Uint8Array([1, 2, 3]),
  width: 1200,
  height: 800,
  quality: 'ok',
};

function captureCoordinator(): CaptureSessionCoordinator {
  return {
    currentTarget: () => TARGET,
    captureFrame: async () => GOOD_FRAME,
    settled: async () => {},
    stop: async () => {},
  };
}

interface Harness {
  readonly server: ListeningHttpServer;
  readonly solveLoop: SolveLoop;
  readonly window: TranscriptWindow;
  /** Every `SolveOptions` the provider was called with, in order. */
  readonly options: SolveOptions[];
  readonly outcomes: SolveOutcomeEvent[];
}

async function startTestServer(
  t: TestContext,
  options: { withWindow?: boolean; withTarget?: boolean } = {},
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
  if (options.withTarget !== false) await configStore.setTargetWindow(TARGET);

  const { routes, solveLoop } = createHostRoutes({
    configStore,
    captureSessionCoordinator: captureCoordinator(),
    provider,
    enumerateWindows: async () => [TARGET],
    transcriptWindow: options.withWindow === false ? undefined : window,
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

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
} as const;

function said(text: string, secondsAgo: number): TranscriptEntry {
  return {
    recordingSessionId: 'session-1',
    channel: 'them',
    text,
    timestamp: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
    startSeconds: 0,
    endSeconds: 1,
    model: 'nova-3',
  };
}

describe('POST /solve/with-transcript', () => {
  it('accepts with 202, the same as the plain route', async (t) => {
    const h = await startTestServer(t);
    const response = await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'accepted' });
  });

  it('sends the windowed speech to the provider', async (t) => {
    const h = await startTestServer(t);
    h.window.add(said('can you do it without extra space', 5));
    h.window.add(said('and handle the empty case', 2));

    await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.options.length, 1);
    assert.equal(
      h.options[0]?.transcript,
      'Them: can you do it without extra space\nThem: and handle the empty case',
    );
  });

  it('POST /solve sends NO transcript, even with speech in the window', async (t) => {
    // The regression guard for "the existing button's behavior is unchanged".
    const h = await startTestServer(t);
    h.window.add(said('this must not reach the model', 2));

    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.options.length, 1);
    assert.equal(h.options[0]?.transcript, undefined);
    assert.equal('transcript' in (h.options[0] ?? {}), false, 'the key is absent, not undefined');
  });

  it('still accepts when the window is empty, and sends nothing rather than an empty block', async (t) => {
    const h = await startTestServer(t);
    const response = await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(response.status, 202);
    assert.equal(h.options[0]?.transcript, undefined);
  });

  it('sends nothing when no transcript window is wired at all', async (t) => {
    const h = await startTestServer(t, { withWindow: false });
    const response = await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(response.status, 202);
    assert.equal(h.options[0]?.transcript, undefined);
  });

  it('refuses with 400 when no target is configured, the same as the plain route', async (t) => {
    const h = await startTestServer(t, { withTarget: false });
    const response = await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'no_target_configured' });
  });

  it('refuses with 503 shutting_down once the loop has stopped', async (t) => {
    const h = await startTestServer(t);
    await h.solveLoop.stop();

    const response = await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'shutting_down' });
  });

  it('answers 503 not_ready when the loop was never built', async (t) => {
    const { routes } = createHostRoutes({});
    const server = await startHttpServer({
      binding: { host: '127.0.0.1', port: 0 },
      routes,
      logger: silentLogger,
    });
    t.after(() => server.close());

    const response = await fetch(`${server.url}/solve/with-transcript`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'not_ready' });
  });
});

describe('withTranscript on the outcome bus', () => {
  it('tags the outcome when speech was actually sent', async (t) => {
    const h = await startTestServer(t);
    h.window.add(said('something was said', 2));

    await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.outcomes[0]?.withTranscript, true);
  });

  it('does NOT tag an ordinary solve', async (t) => {
    const h = await startTestServer(t);
    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.outcomes[0]?.withTranscript, undefined);
  });

  it('does not tag a transcript solve that happened during silence', async (t) => {
    // Nothing was sent, so the honest record is that this was an ordinary solve.
    const h = await startTestServer(t);
    await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.outcomes[0]?.withTranscript, undefined);
  });
});
