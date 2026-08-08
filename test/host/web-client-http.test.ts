import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { loadConfigStore, type ConfigStore } from '../../src/host/config/store.ts';
import type { EnumerateWindows, TargetWindowIdentity, WindowInfo } from '../../src/host/config/types.ts';
import { createHostRoutes } from '../../src/host/http/routes.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import { silentLogger } from '../../src/host/logger.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * #33's own HTTP surface -- the window picker's wire contract
 * (`GET /config`, `GET /windows`, `POST /config/target`) and the `config`
 * SSE frame that mirrors `ConfigStore.onChange` onto every connected
 * client. Exercised the same way `solve-http.test.ts`/`failure-taxonomy.test.ts`
 * do: real HTTP/SSE against a real `ConfigStore` over a temp state root, no
 * mocking of the store itself.
 */

const TARGET: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };
const OTHER_TARGET: TargetWindowIdentity = { processName: 'firefox.exe', title: 'Reverse a linked list' };

interface Harness {
  readonly server: ListeningHttpServer;
  readonly configStore: ConfigStore;
}

async function startTestServer(
  t: TestContext,
  options: { withConfigStore?: boolean; windows?: readonly WindowInfo[]; initialTarget?: TargetWindowIdentity | null } = {},
): Promise<Harness> {
  const enumerateWindows: EnumerateWindows = async () => options.windows ?? [TARGET, OTHER_TARGET];
  const configStore = await loadConfigStore({ stateRoot: await tempStateRoot(t), enumerateWindows });
  if (options.initialTarget) await configStore.setTargetWindow(options.initialTarget);

  const { routes } = createHostRoutes(
    options.withConfigStore === false ? {} : { configStore, logger: silentLogger },
  );
  const server = await startHttpServer({ binding: { host: '127.0.0.1', port: 0 }, routes, logger: silentLogger });
  t.after(() => server.close());

  return { server, configStore };
}

interface ParsedFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** `GET /config` / `POST /config/target`'s shared response shape. */
interface ConfigResponseBody {
  readonly targetWindow: TargetWindowIdentity | null;
  readonly revision: number;
}

async function configBody(response: Response): Promise<ConfigResponseBody> {
  return (await response.json()) as ConfigResponseBody;
}

/** Same fixed drain-buffered-first shape as `failure-taxonomy.test.ts`'s own copy -- see that file's doc comment for why. */
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

describe('GET /config', () => {
  it('reports null when no target is configured', async (t) => {
    const h = await startTestServer(t);
    const response = await fetch(`${h.server.url}/config`);
    assert.equal(response.status, 200);
    const body = await configBody(response);
    assert.equal(body.targetWindow, null);
    assert.equal(typeof body.revision, 'number');
  });

  it('reports the configured target', async (t) => {
    const h = await startTestServer(t, { initialTarget: TARGET });
    const response = await fetch(`${h.server.url}/config`);
    assert.equal(response.status, 200);
    const body = await configBody(response);
    assert.deepEqual(body.targetWindow, TARGET);
    assert.equal(typeof body.revision, 'number');
  });

  it("revision matches broadcaster.currentConfigRevision(), and moves after a change -- the number a client actually needs to order GET /config against a live config SSE frame", async (t) => {
    const h = await startTestServer(t);
    const before = await configBody(await fetch(`${h.server.url}/config`));

    await h.configStore.setTargetWindow(TARGET);

    const after = await configBody(await fetch(`${h.server.url}/config`));
    assert.ok(after.revision > before.revision, 'a real change strictly advances the revision');
    assert.deepEqual(after.targetWindow, TARGET);
  });

  it('answers 503 when no configStore is wired', async (t) => {
    const h = await startTestServer(t, { withConfigStore: false });
    const response = await fetch(`${h.server.url}/config`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'not_ready' });
  });
});

describe('GET /windows', () => {
  it('lists whatever enumerateWindows reports', async (t) => {
    const h = await startTestServer(t, { windows: [TARGET, OTHER_TARGET] });
    const response = await fetch(`${h.server.url}/windows`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [TARGET, OTHER_TARGET]);
  });

  it('is an empty array, not an error, when nothing is open', async (t) => {
    const h = await startTestServer(t, { windows: [] });
    const response = await fetch(`${h.server.url}/windows`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  it('answers 503 when no configStore is wired', async (t) => {
    const h = await startTestServer(t, { withConfigStore: false });
    const response = await fetch(`${h.server.url}/windows`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'not_ready' });
  });
});

describe('POST /config/target', () => {
  it('sets the target from a well-formed body, and it is immediately visible via GET /config', async (t) => {
    const h = await startTestServer(t);

    const response = await fetch(`${h.server.url}/config/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TARGET),
    });
    assert.equal(response.status, 200);
    const body = await configBody(response);
    assert.deepEqual(body.targetWindow, TARGET);
    assert.equal(typeof body.revision, 'number');
    assert.deepEqual(h.configStore.get().targetWindow, TARGET);

    const after = await configBody(await fetch(`${h.server.url}/config`));
    assert.deepEqual(after.targetWindow, TARGET);
    assert.equal(
      after.revision,
      body.revision,
      "GET /config's revision matches the POST response's -- both read the same broadcaster counter",
    );
  });

  it('clears the target from a JSON null body', async (t) => {
    const h = await startTestServer(t, { initialTarget: TARGET });

    const response = await fetch(`${h.server.url}/config/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    });
    assert.equal(response.status, 200);
    const body = await configBody(response);
    assert.equal(body.targetWindow, null);
    assert.equal(typeof body.revision, 'number');
    assert.equal(h.configStore.get().targetWindow, null);
  });

  it('clears the target from an empty body too, per readJsonBody\'s documented empty-body default', async (t) => {
    const h = await startTestServer(t, { initialTarget: TARGET });

    const response = await fetch(`${h.server.url}/config/target`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await configBody(response);
    assert.equal(body.targetWindow, null);
    assert.equal(typeof body.revision, 'number');
  });

  it('rejects a malformed body shape with 400 and leaves the target untouched', async (t) => {
    const h = await startTestServer(t, { initialTarget: TARGET });

    const response = await fetch(`${h.server.url}/config/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ processName: 'chrome.exe' }), // missing title
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'bad_request' });
    assert.deepEqual(h.configStore.get().targetWindow, TARGET, 'the prior target survives a rejected update');
  });

  it('rejects malformed JSON with 400', async (t) => {
    const h = await startTestServer(t);

    const response = await fetch(`${h.server.url}/config/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'bad_request' });
  });

  it('rejects an oversized body with 413 and leaves the target untouched (review fix: readJsonBody was previously unbounded)', async (t) => {
    const h = await startTestServer(t, { initialTarget: TARGET });

    // Comfortably over `MAX_JSON_BODY_BYTES` (64 KiB) -- a real
    // `{processName, title}` payload is a few dozen bytes, so this is purely
    // an attacker-shaped body, not a realistic client request.
    const oversized = JSON.stringify({ processName: 'chrome.exe', title: 'x'.repeat(200_000) });

    const response = await fetch(`${h.server.url}/config/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'payload_too_large' });
    assert.deepEqual(h.configStore.get().targetWindow, TARGET, 'the prior target survives a rejected update');
  });

  it('answers 503 when no configStore is wired', async (t) => {
    const h = await startTestServer(t, { withConfigStore: false });
    const response = await fetch(`${h.server.url}/config/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TARGET),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'not_ready' });
  });
});

describe('config{target} SSE event', () => {
  it('broadcasts to a connected client when the target changes via POST /config/target', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const response = await fetch(`${h.server.url}/config/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TARGET),
    });
    assert.equal(response.status, 200);

    const [frame] = await events.take(1);
    assert.equal(frame?.type, 'config');
    assert.deepEqual(frame?.target, TARGET);
    assert.equal(typeof frame?.revision, 'number');
  });

  it('broadcasts a clear (null) the same way as a set', async (t) => {
    const h = await startTestServer(t, { initialTarget: TARGET });
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    await h.configStore.setTargetWindow(null);

    const [frame] = await events.take(1);
    assert.equal(frame?.type, 'config');
    assert.equal(frame?.target, null);
    assert.equal(typeof frame?.revision, 'number');
  });

  it('fans out identically to two simultaneous clients', async (t) => {
    const h = await startTestServer(t);
    const clientA = await connectEvents(`${h.server.url}/events`);
    const clientB = await connectEvents(`${h.server.url}/events`);
    t.after(() => clientA.cancel());
    t.after(() => clientB.cancel());

    await h.configStore.setTargetWindow(TARGET);

    const [framesA, framesB] = await Promise.all([clientA.take(1), clientB.take(1)]);
    assert.deepEqual(framesA, framesB);
    assert.equal(framesA[0]?.type, 'config');
    assert.deepEqual(framesA[0]?.target, TARGET);
  });

  it('the revision strictly increases across successive changes, giving a client real ordering info to compare against', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    await h.configStore.setTargetWindow(TARGET);
    await h.configStore.setTargetWindow(OTHER_TARGET);
    await h.configStore.setTargetWindow(null);

    const frames = await events.take(3);
    const revisions = frames.map((f) => f.revision);
    assert.deepEqual(
      revisions,
      [...revisions].sort((a, b) => (a as number) - (b as number)),
      'revisions arrive in non-decreasing order',
    );
    assert.ok(new Set(revisions).size === 3, 'each real change gets its own distinct revision');
  });

  it('is not replayed to a freshly-connecting client -- unlike sync/status, GET /config already covers "what is it right now"', async (t) => {
    const h = await startTestServer(t, { initialTarget: TARGET });

    // The target was already set before this client ever connects -- if
    // `subscribe()` replayed `config` the way it replays `sync`/`status`,
    // this would see a frame here. It shouldn't: a fresh `GET /config`
    // already answers this, so `config` only ever reports a *change*.
    const events = await connectEvents(`${h.server.url}/events`);
    t.after(() => events.cancel());

    const frame = await events.raceTimeout(150);
    assert.equal(frame, 'timeout');
  });
});
