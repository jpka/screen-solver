import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { createTranscriptWindow, type TranscriptWindow } from '../../src/host/audio/window.ts';
import type { CaptureSessionCoordinator } from '../../src/host/capture/session-coordinator.ts';
import type { CapturedFrame } from '../../src/host/capture/types.ts';
import { loadConfigStore } from '../../src/host/config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity } from '../../src/host/config/types.ts';
import { createHostRoutes } from '../../src/host/http/routes.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import type { TranscriptEntry } from '../../src/host/logs/types.ts';
import { silentLogger } from '../../src/host/logger.ts';
import type { Provider, SolveImage, SolveOptions } from '../../src/host/provider/types.ts';
import type { SolveLoop } from '../../src/host/solve/loop.ts';
import type { SolveOutcomeEvent } from '../../src/host/solve/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * `POST /solve/with-transcript` and `POST /solve/transcript-only` -- and, just
 * as importantly, the guard that `POST /solve` still sends no transcript at
 * all. All three routes come from one factory in `routes.ts`, so the risk
 * worth testing is not that they diverge in status codes but that the plain
 * one quietly starts carrying speech, or that the spoken-only one quietly
 * starts requiring a target window / running the capture guards it is meant
 * to skip.
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
  /** Every `image` the provider was called with, in the same order as {@link options}. `null` marks a spoken-only call. */
  readonly images: (SolveImage | null)[];
  readonly outcomes: SolveOutcomeEvent[];
}

async function startTestServer(
  t: TestContext,
  options: {
    withWindow?: boolean;
    withTarget?: boolean;
    /**
     * The pre-flight capture guard's own view of what's open -- distinct from
     * the enumerator `loadConfigStore` uses once at startup to re-resolve
     * `TARGET`. Defaults to `TARGET` always being present; a test can hand
     * back `[]` to simulate a target that has vanished entirely.
     */
    enumerateWindows?: EnumerateWindows;
  } = {},
): Promise<Harness> {
  const seen: SolveOptions[] = [];
  const images: (SolveImage | null)[] = [];
  const outcomes: SolveOutcomeEvent[] = [];
  const window = createTranscriptWindow();

  const provider: Provider = {
    model: 'fake-model',
    // eslint-disable-next-line require-yield
    async *solve(image, solveOptions = {}) {
      images.push(image);
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
    enumerateWindows: options.enumerateWindows ?? (async () => [TARGET]),
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

  return { server, solveLoop, window, options: seen, images, outcomes };
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

  it('regression: /solve/with-transcript still sends a non-null image', async (t) => {
    const h = await startTestServer(t);
    h.window.add(said('a hint about the screen', 2));

    await fetch(`${h.server.url}/solve/with-transcript`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.notEqual(h.images[0], null);
  });
});

describe('POST /solve/transcript-only', () => {
  it('accepts with 202 when something has been said', async (t) => {
    const h = await startTestServer(t);
    h.window.add(said('what is the time complexity of this', 2));

    const response = await fetch(`${h.server.url}/solve/transcript-only`, { method: 'POST' });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'accepted' });
  });

  it('accepts with 202 even when no target window is configured -- nothing is captured, so none is needed', async (t) => {
    const h = await startTestServer(t, { withTarget: false });
    h.window.add(said('what is the time complexity of this', 2));

    const response = await fetch(`${h.server.url}/solve/transcript-only`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(response.status, 202);
    assert.equal(h.options.length, 1, 'the provider really was called, with no target at all');
  });

  it('refuses with 400 no_transcript when nothing has been said, and never calls the provider or reports an outcome', async (t) => {
    const h = await startTestServer(t);

    const response = await fetch(`${h.server.url}/solve/transcript-only`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'no_transcript' });
    assert.equal(h.options.length, 0, 'an empty window must not spend a call to find out it was empty');
    assert.equal(h.outcomes.length, 0);
  });

  it('hands the provider image: null and the rendered transcript', async (t) => {
    const h = await startTestServer(t);
    h.window.add(said('can this be done in O(n)', 3));

    await fetch(`${h.server.url}/solve/transcript-only`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.images[0], null);
    assert.equal(h.options[0]?.transcript, 'Them: can this be done in O(n)');
  });

  it('reaches the provider even with the configured target vanished entirely, where /solve would have bailed silently -- proof the capture guards are skipped, not merely passing', async (t) => {
    const h = await startTestServer(t, { enumerateWindows: async () => [] });
    h.window.add(said('what does this function return', 2));

    // Sanity check first: the same vanished target really does block the plain route.
    await fetch(`${h.server.url}/solve`, { method: 'POST' });
    await h.solveLoop.settled();
    assert.equal(h.options.length, 0, 'sanity check: /solve is blocked by the vanished target');

    const response = await fetch(`${h.server.url}/solve/transcript-only`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(response.status, 202);
    assert.equal(h.options.length, 1, 'transcript-only reached the provider despite the same vanished target');
    assert.equal(h.images[0], null);
  });

  it('refuses with 503 shutting_down once the loop has stopped', async (t) => {
    const h = await startTestServer(t);
    h.window.add(said('something was said', 2));
    await h.solveLoop.stop();

    const response = await fetch(`${h.server.url}/solve/transcript-only`, { method: 'POST' });
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

    const response = await fetch(`${server.url}/solve/transcript-only`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'not_ready' });
  });

  it('reports target: null and withTranscript: true on the outcome bus', async (t) => {
    const h = await startTestServer(t);
    h.window.add(said('what is the answer here', 2));

    await fetch(`${h.server.url}/solve/transcript-only`, { method: 'POST' });
    await h.solveLoop.settled();

    assert.equal(h.outcomes[0]?.target, null);
    assert.equal(h.outcomes[0]?.withTranscript, true);
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
