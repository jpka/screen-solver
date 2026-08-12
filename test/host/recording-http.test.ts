import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { loadConfigStore, type ConfigStore } from '../../src/host/config/store.ts';
import type { TargetWindowIdentity } from '../../src/host/config/types.ts';
import { createHostRoutes } from '../../src/host/http/routes.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import { silentLogger } from '../../src/host/logger.ts';
import { createRecordingLog, RECORDINGS_DIR_NAME } from '../../src/host/logs/recording-log.ts';
import type { RecordingSegment } from '../../src/host/logs/types.ts';
import {
  createRecordingCoordinator,
  type RecordingCoordinator,
} from '../../src/host/recording/coordinator.ts';
import { createSegmentWriter } from '../../src/host/recording/segment-writer.ts';
import type { OpenRecorder } from '../../src/host/recording/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * #45's HTTP surface: the recorder's control and playback endpoints, plus the
 * `recording` SSE frame.
 *
 * Same approach as `web-client-http.test.ts` -- real HTTP over a real
 * `ConfigStore` and a real recording index on a temp state root. Only the
 * renderer's `MediaRecorder` is faked, since that is the one thing that needs a
 * real composited desktop.
 */

const TARGET: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };

interface Harness {
  readonly server: ListeningHttpServer;
  readonly configStore: ConfigStore;
  readonly coordinator: RecordingCoordinator;
  readonly stateRoot: string;
  readonly recordingsDir: string;
}

/** A recorder that opens successfully and produces nothing unless asked. */
function idleRecorder(): OpenRecorder {
  return async () => ({
    mimeType: 'video/webm;codecs=vp9',
    async roll(): Promise<void> {},
    async close(): Promise<void> {},
  });
}

async function startTestServer(
  t: TestContext,
  options: { readonly withTarget?: boolean; readonly withCoordinator?: boolean } = {},
): Promise<Harness> {
  const stateRoot = await tempStateRoot(t);
  const recordingsDir = join(stateRoot, RECORDINGS_DIR_NAME);
  const configStore = await loadConfigStore({
    stateRoot,
    enumerateWindows: async () => [TARGET],
  });
  if (options.withTarget !== false) await configStore.setTargetWindow(TARGET);

  const recordingLog = createRecordingLog({ stateRoot });
  let coordinator: RecordingCoordinator;
  coordinator = createRecordingCoordinator({
    writer: createSegmentWriter({
      dir: recordingsDir,
      recordingLog,
      onError: (reason) => coordinator.fail(reason),
    }),
    recordingLog,
    openRecorder: idleRecorder(),
    settings: () => configStore.get().recording,
    currentTarget: () => configStore.get().targetWindow,
  });
  t.after(() => coordinator.stop());

  const { routes } = createHostRoutes({
    configStore,
    recordingCoordinator: options.withCoordinator === false ? undefined : coordinator,
    recordingLog,
    recordingsDir,
    logger: silentLogger,
  });
  const server = await startHttpServer({
    binding: { host: '127.0.0.1', port: 0 },
    routes,
    logger: silentLogger,
  });
  t.after(() => server.close());

  return { server, configStore, coordinator, stateRoot, recordingsDir };
}

describe('recording HTTP surface', () => {
  describe('POST /recording/start', () => {
    it('starts recording and answers with the live snapshot', async (t) => {
      const h = await startTestServer(t);

      const response = await fetch(`${h.server.url}/recording/start`, { method: 'POST' });
      const body = (await response.json()) as { state: string; segmentId: string | null };

      assert.equal(response.status, 200);
      assert.equal(body.state, 'recording');
      assert.notEqual(body.segmentId, null);
    });

    it('refuses with 409 when no window is being captured', async (t) => {
      const h = await startTestServer(t, { withTarget: false });

      const response = await fetch(`${h.server.url}/recording/start`, { method: 'POST' });

      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'no_capture_session' });
      assert.equal(h.coordinator.snapshot().state, 'off', 'and nothing was started');
    });

    it('answers 503 when no coordinator is wired', async (t) => {
      const h = await startTestServer(t, { withCoordinator: false });

      const response = await fetch(`${h.server.url}/recording/start`, { method: 'POST' });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'not_ready' });
    });
  });

  it('GET /recording reports the state a freshly-loaded client needs before any SSE frame', async (t) => {
    const h = await startTestServer(t);

    const before = (await (await fetch(`${h.server.url}/recording`)).json()) as { state: string };
    assert.equal(before.state, 'off');

    await fetch(`${h.server.url}/recording/start`, { method: 'POST' });

    const after = (await (await fetch(`${h.server.url}/recording`)).json()) as { state: string };
    assert.equal(after.state, 'recording');
  });

  it('POST /recording/stop returns to off', async (t) => {
    const h = await startTestServer(t);
    await fetch(`${h.server.url}/recording/start`, { method: 'POST' });

    const response = await fetch(`${h.server.url}/recording/stop`, { method: 'POST' });

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { state: string }).state, 'off');
  });

  describe('GET /recordings', () => {
    it('is empty before anything has been recorded', async (t) => {
      const h = await startTestServer(t);

      const response = await fetch(`${h.server.url}/recordings`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), []);
    });

    it('lists a segment as soon as it opens, before it has been closed out', async (t) => {
      const h = await startTestServer(t);
      await fetch(`${h.server.url}/recording/start`, { method: 'POST' });

      const segments = (await (await fetch(`${h.server.url}/recordings`)).json()) as RecordingSegment[];

      assert.equal(segments.length, 1);
      assert.equal(segments[0]?.endedAt, null, 'still being written');
      assert.deepEqual(segments[0]?.target, TARGET);
    });
  });

  describe('GET /recordings/file', () => {
    /** Puts a real, indexed segment file on disk without going through the recorder. */
    async function seedSegment(h: Harness, id: string, contents: Buffer): Promise<void> {
      await mkdir(h.recordingsDir, { recursive: true });
      await writeFile(join(h.recordingsDir, `${id}.webm`), contents);
      const log = createRecordingLog({ stateRoot: h.stateRoot });
      await log.append({
        type: 'opened',
        id,
        startedAt: '2026-08-12T09:00:00.000Z',
        mimeType: 'video/webm',
        target: TARGET,
      });
      await log.append({
        type: 'closed',
        id,
        endedAt: '2026-08-12T09:05:00.000Z',
        bytes: contents.byteLength,
      });
    }

    it('serves the whole file, advertising range support', async (t) => {
      const h = await startTestServer(t);
      await seedSegment(h, 'abc', Buffer.from('0123456789'));

      const response = await fetch(`${h.server.url}/recordings/file?id=abc`);

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('content-type'), 'video/webm');
      assert.equal(response.headers.get('content-length'), '10');
      assert.equal(await response.text(), '0123456789');
    });

    it('answers a range request with 206 and the requested slice, so <video> can seek', async (t) => {
      const h = await startTestServer(t);
      await seedSegment(h, 'abc', Buffer.from('0123456789'));

      const response = await fetch(`${h.server.url}/recordings/file?id=abc`, {
        headers: { range: 'bytes=2-5' },
      });

      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
      assert.equal(response.headers.get('content-length'), '4');
      assert.equal(await response.text(), '2345');
    });

    it('answers 416 for a range entirely past the end', async (t) => {
      const h = await startTestServer(t);
      await seedSegment(h, 'abc', Buffer.from('0123456789'));

      const response = await fetch(`${h.server.url}/recordings/file?id=abc`, {
        headers: { range: 'bytes=99-200' },
      });

      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), 'bytes */10');
    });

    it('404s an id that is not in the index', async (t) => {
      const h = await startTestServer(t);

      const response = await fetch(`${h.server.url}/recordings/file?id=nope`);

      assert.equal(response.status, 404);
    });

    it('404s an indexed segment whose file has vanished from disk', async (t) => {
      const h = await startTestServer(t);
      const log = createRecordingLog({ stateRoot: h.stateRoot });
      await log.append({
        type: 'opened',
        id: 'ghost',
        startedAt: '2026-08-12T09:00:00.000Z',
        mimeType: 'video/webm',
        target: null,
      });

      const response = await fetch(`${h.server.url}/recordings/file?id=ghost`);

      assert.equal(response.status, 404);
    });

    it('refuses a traversal attempt rather than reading outside the recordings directory', async (t) => {
      const h = await startTestServer(t);
      // Planted in the index deliberately: resolving ids through the index is
      // the primary defence, so this test defeats that defence on purpose to
      // prove the containment check behind it also holds.
      const log = createRecordingLog({ stateRoot: h.stateRoot });
      await log.append({
        type: 'opened',
        id: '../../config',
        startedAt: '2026-08-12T09:00:00.000Z',
        mimeType: 'video/webm',
        target: null,
      });

      const response = await fetch(
        `${h.server.url}/recordings/file?id=${encodeURIComponent('../../config')}`,
      );

      assert.equal(response.status, 400);
    });

    it('400s a request with no id at all', async (t) => {
      const h = await startTestServer(t);

      assert.equal((await fetch(`${h.server.url}/recordings/file`)).status, 400);
    });
  });

  describe('recording settings', () => {
    it('round-trips a partial patch, leaving the untouched fields alone', async (t) => {
      const h = await startTestServer(t);

      const response = await fetch(`${h.server.url}/recording/settings`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
      });
      const body = (await response.json()) as { enabled: boolean; segmentSeconds: number };

      assert.equal(response.status, 200);
      assert.equal(body.enabled, true);
      assert.equal(body.segmentSeconds, 300, 'the default survived a patch that never mentioned it');
      assert.equal(h.configStore.get().recording.enabled, true, 'and it reached the store');
    });

    it('answers with the clamped value rather than echoing an out-of-range request', async (t) => {
      const h = await startTestServer(t);

      const response = await fetch(`${h.server.url}/recording/settings`, {
        method: 'POST',
        body: JSON.stringify({ segmentSeconds: 0 }),
      });

      assert.equal(((await response.json()) as { segmentSeconds: number }).segmentSeconds, 5);
    });

    it('rejects a field of the wrong type with 400, rather than silently dropping it', async (t) => {
      const h = await startTestServer(t);

      const response = await fetch(`${h.server.url}/recording/settings`, {
        method: 'POST',
        body: JSON.stringify({ enabled: 'yes please' }),
      });

      assert.equal(response.status, 400);
      assert.equal(h.configStore.get().recording.enabled, false, 'and nothing changed');
    });

    it('persists across a reload of the store, which is what makes automatic recording automatic', async (t) => {
      const h = await startTestServer(t);
      await fetch(`${h.server.url}/recording/settings`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true, retentionDays: 3 }),
      });

      const reloaded = await loadConfigStore({ stateRoot: h.stateRoot });

      assert.equal(reloaded.get().recording.enabled, true);
      assert.equal(reloaded.get().recording.retentionDays, 3);
    });
  });

  describe('the recording SSE frame', () => {
    it('broadcasts a state change to a connected client', async (t) => {
      const h = await startTestServer(t);
      const events = await fetch(`${h.server.url}/events`);
      const frames = frameReader(events);

      await fetch(`${h.server.url}/recording/start`, { method: 'POST' });

      // `starting` then `recording`; the first real frame is enough to prove
      // the wiring, and waiting for a specific later one would race the tick.
      const frame = await frames.next();
      assert.equal(frame?.type, 'recording');
      assert.ok(
        frame?.state === 'starting' || frame?.state === 'recording',
        `unexpected first state: ${String(frame?.state)}`,
      );
    });

    it('replays the current state to a client that connects mid-recording', async (t) => {
      const h = await startTestServer(t);
      await fetch(`${h.server.url}/recording/start`, { method: 'POST' });

      const events = await fetch(`${h.server.url}/events`);
      const frames = frameReader(events);
      const frame = await frames.next();

      // The catch-up. Without it a phone opened during a recording would show
      // "not recording" until the next change -- the one thing this feature
      // must never say.
      assert.equal(frame?.type, 'recording');
      assert.equal(frame?.state, 'recording');
    });

    it('sends no catch-up frame when nothing is recording', async (t) => {
      const h = await startTestServer(t);

      const events = await fetch(`${h.server.url}/events`);
      const frames = frameReader(events);

      assert.equal(await frames.nextWithin(250), null);
    });
  });
});

/** Reads `event:`/`data:` SSE frames off a live response body. */
function frameReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  async function pump(): Promise<Record<string, unknown> | null> {
    for (;;) {
      const boundary = buffered.indexOf('\n\n');
      if (boundary !== -1) {
        const raw = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine === undefined) continue; // the `:ok` preamble
        return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
    }
  }

  return {
    next: pump,
    /** `null` if no frame arrives within `ms` -- for asserting that nothing is sent. */
    async nextWithin(ms: number): Promise<Record<string, unknown> | null> {
      return Promise.race([
        pump(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
      ]);
    },
  };
}
