import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import type {
  OpenAudioCapture,
  Transcriber,
  TranscriberStream,
  TranscriptChannel,
  TranscriptEvent,
} from '../../src/host/audio/types.ts';
import { createTranscriptWindow } from '../../src/host/audio/window.ts';
import { createHostRoutes, MAX_TRANSCRIPT_LIMIT } from '../../src/host/http/routes.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import { createTranscriptLog } from '../../src/host/logs/transcript-log.ts';
import type { TranscriptEntry } from '../../src/host/logs/types.ts';
import { silentLogger } from '../../src/host/logger.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/**
 * The recording feature's HTTP surface -- `GET`/`POST /recording`,
 * `GET /transcript`, and the three SSE frames that carry a live transcript to
 * a connected client. Exercised the way `web-client-http.test.ts` does: a real
 * server on port 0 over a real `transcript.jsonl` in a temp state root, with
 * only the audio device and the transcription socket faked.
 */

interface FakeStream extends TranscriberStream {
  readonly channel: TranscriptChannel;
  emit(event: TranscriptEvent): void;
}

interface Harness {
  readonly server: ListeningHttpServer;
  readonly stateRoot: string;
  /** Drives transcript events as though they had come off a Deepgram socket. */
  stream(): FakeStream;
  /** Waits for every queued `transcript.jsonl` write to land. */
  drain(): Promise<void>;
  seed(entries: readonly TranscriptEntry[]): Promise<void>;
}

async function startTestServer(
  t: TestContext,
  options: { available?: boolean } = {},
): Promise<Harness> {
  const streams: FakeStream[] = [];
  const stateRoot = await tempStateRoot(t);
  const transcriptLog = createTranscriptLog({ stateRoot });

  const transcriber: Transcriber = {
    model: 'nova-3',
    open({ channel, onEvent }) {
      const stream: FakeStream = {
        channel,
        send() {},
        async close() {},
        emit: onEvent,
      };
      streams.push(stream);
      return stream;
    },
  };
  const openAudioCapture: OpenAudioCapture = async () => ({ async close() {} });

  const available = options.available !== false;
  const { routes, recordingCoordinator } = createHostRoutes({
    transcriber: available ? transcriber : undefined,
    openAudioCapture: available ? openAudioCapture : undefined,
    transcriptLog,
    transcriptWindow: createTranscriptWindow(),
    logger: silentLogger,
  });

  const server = await startHttpServer({
    binding: { host: '127.0.0.1', port: 0 },
    routes,
    logger: silentLogger,
  });
  t.after(() => server.close());

  return {
    server,
    stateRoot,
    stream() {
      const found = streams[streams.length - 1];
      assert.ok(found !== undefined, 'no transcription stream was opened');
      return found;
    },
    drain: () => recordingCoordinator.drain(),
    async seed(entries) {
      for (const entry of entries) await transcriptLog.append(entry);
    },
  };
}

interface RecordingBody {
  readonly state: string;
  readonly sessionId: string | null;
  readonly revision: number;
}

async function recordingBody(response: Response): Promise<RecordingBody> {
  return (await response.json()) as RecordingBody;
}

function setRecording(url: string, on: boolean): Promise<Response> {
  return fetch(`${url}/recording`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on }),
  });
}

function entry(text: string, index: number): TranscriptEntry {
  return {
    recordingSessionId: 'seeded',
    channel: 'them',
    text,
    timestamp: new Date(Date.parse('2026-08-11T09:00:00.000Z') + index * 1_000).toISOString(),
    startSeconds: index,
    endSeconds: index + 1,
    model: 'nova-3',
  };
}

interface ParsedFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Same fixed drain-buffered-first shape as `web-client-http.test.ts`'s own copy. */
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
      return Promise.race([
        this.take(1).then((frames) => frames[0] ?? ('timeout' as const)),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
      ]);
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => {});
    },
  };
}

async function connectEvents(url: string): Promise<ReturnType<typeof frameReader>> {
  return frameReader(await fetch(`${url}/events`));
}

describe('GET /recording', () => {
  it('reports off with no session before anything has been toggled', async (t) => {
    const h = await startTestServer(t);
    const response = await fetch(`${h.server.url}/recording`);

    assert.equal(response.status, 200);
    const body = await recordingBody(response);
    assert.equal(body.state, 'off');
    assert.equal(body.sessionId, null);
    assert.equal(typeof body.revision, 'number');
  });

  it('reports unavailable, not a 503, when no transcription key was wired', async (t) => {
    // The server is perfectly ready; this one capability just isn't configured,
    // and saying so is more useful to a client than claiming not_ready.
    const h = await startTestServer(t, { available: false });
    const response = await fetch(`${h.server.url}/recording`);

    assert.equal(response.status, 200);
    assert.equal((await recordingBody(response)).state, 'unavailable');
  });
});

describe('POST /recording', () => {
  it('starts recording and hands back a session id', async (t) => {
    const h = await startTestServer(t);
    const body = await recordingBody(await setRecording(h.server.url, true));

    assert.equal(body.state, 'starting');
    assert.equal(typeof body.sessionId, 'string');
  });

  it('stops recording and clears the session id', async (t) => {
    const h = await startTestServer(t);
    await setRecording(h.server.url, true);
    const body = await recordingBody(await setRecording(h.server.url, false));

    assert.equal(body.state, 'off');
    assert.equal(body.sessionId, null);
  });

  it('the revision strictly increases across transitions', async (t) => {
    const h = await startTestServer(t);
    const first = await recordingBody(await setRecording(h.server.url, true));
    const second = await recordingBody(await setRecording(h.server.url, false));
    const third = await recordingBody(await setRecording(h.server.url, true));

    assert.ok(second.revision > first.revision);
    assert.ok(third.revision > second.revision);
  });

  it('answers with exactly the revision the SSE frame it caused carried', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(h.server.url);

    const response = await recordingBody(await setRecording(h.server.url, true));
    const frames = await events.take(1);

    assert.equal(frames[0]?.type, 'recording');
    assert.equal(frames[0]?.state, response.state);
    assert.equal(frames[0]?.revision, response.revision);
    await events.cancel();
  });

  it('rejects a body that does not say on or off', async (t) => {
    const h = await startTestServer(t);
    for (const body of ['{}', 'null', '{"on":"yes"}', 'not json']) {
      const response = await fetch(`${h.server.url}/recording`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(response.status, 400, `body ${body} should be rejected`);
    }
  });

  it('rejects an empty body, unlike POST /config/target where clearing has a meaning', async (t) => {
    const h = await startTestServer(t);
    const response = await fetch(`${h.server.url}/recording`, { method: 'POST' });
    assert.equal(response.status, 400);
  });

  it('rejects an oversized body with 413', async (t) => {
    const h = await startTestServer(t);
    const response = await fetch(`${h.server.url}/recording`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true, padding: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(response.status, 413);
  });

  it('refuses with recording_unavailable when nothing is wired', async (t) => {
    const h = await startTestServer(t, { available: false });
    const response = await setRecording(h.server.url, true);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'recording_unavailable' });
  });
});

describe('transcript SSE frames', () => {
  it('broadcasts a final as a transcript frame carrying the persisted entry', async (t) => {
    const h = await startTestServer(t);
    await setRecording(h.server.url, true);
    const events = await connectEvents(h.server.url);

    h.stream().emit({ type: 'open' });
    h.stream().emit({ type: 'final', text: 'two sum', startSeconds: 1, endSeconds: 2 });

    // Three frames: the mid-session `recording` replay on connect, the
    // starting -> on transition, then the transcript itself.
    const frames = await events.take(3);
    const transcript = frames.find((f) => f.type === 'transcript');
    assert.ok(transcript !== undefined);
    assert.equal((transcript.entry as TranscriptEntry).text, 'two sum');
    assert.equal((transcript.entry as TranscriptEntry).channel, 'them');
    await events.cancel();
  });

  it('broadcasts an interim as its own frame, replacing rather than appending', async (t) => {
    const h = await startTestServer(t);
    await setRecording(h.server.url, true);
    const events = await connectEvents(h.server.url);

    h.stream().emit({ type: 'open' });
    h.stream().emit({ type: 'interim', text: 'two s' });
    h.stream().emit({ type: 'interim', text: 'two sum' });

    // recording replay, starting -> on, then both interims.
    const frames = await events.take(4);
    const interims = frames.filter((f) => f.type === 'transcript-interim');
    assert.deepEqual(interims.map((f) => f.text), ['two s', 'two sum']);
    await events.cancel();
  });

  it('replays a live recording state to a client that connects mid-session', async (t) => {
    const h = await startTestServer(t);
    await setRecording(h.server.url, true);

    // A phone unlocking mid-meeting must not show an Off toggle over a
    // running session.
    const events = await connectEvents(h.server.url);
    const frames = await events.take(1);
    assert.equal(frames[0]?.type, 'recording');
    assert.equal(frames[0]?.state, 'starting');
    await events.cancel();
  });

  it('replays the pending interim line so a mid-sentence join is not staring at a blank pane', async (t) => {
    const h = await startTestServer(t);
    await setRecording(h.server.url, true);
    h.stream().emit({ type: 'open' });
    h.stream().emit({ type: 'interim', text: 'halfway through a sen' });

    const events = await connectEvents(h.server.url);
    const frames = await events.take(2);
    const interim = frames.find((f) => f.type === 'transcript-interim');
    assert.equal(interim?.text, 'halfway through a sen');
    await events.cancel();
  });

  it('does NOT replay finalized transcript lines -- GET /transcript already covers those', async (t) => {
    const h = await startTestServer(t);
    await setRecording(h.server.url, true);
    h.stream().emit({ type: 'open' });
    h.stream().emit({ type: 'final', text: 'already said', startSeconds: 0, endSeconds: 1 });
    await h.drain();

    const events = await connectEvents(h.server.url);
    const frames = await events.take(1);
    assert.equal(frames.find((f) => f.type === 'transcript'), undefined);
    await events.cancel();
  });

  it('does not replay a recording state of off', async (t) => {
    const h = await startTestServer(t);
    const events = await connectEvents(h.server.url);
    assert.equal(await events.raceTimeout(120), 'timeout');
    await events.cancel();
  });

  it('fans out identically to two simultaneous clients', async (t) => {
    const h = await startTestServer(t);
    await setRecording(h.server.url, true);
    const a = await connectEvents(h.server.url);
    const b = await connectEvents(h.server.url);

    h.stream().emit({ type: 'open' });
    h.stream().emit({ type: 'final', text: 'shared', startSeconds: 0, endSeconds: 1 });

    const [fromA, fromB] = await Promise.all([a.take(3), b.take(3)]);
    assert.deepEqual(
      fromA.filter((f) => f.type === 'transcript'),
      fromB.filter((f) => f.type === 'transcript'),
    );
    await a.cancel();
    await b.cancel();
  });
});

describe('GET /transcript', () => {
  it('answers [] when nothing has ever been transcribed', async (t) => {
    const h = await startTestServer(t);
    const response = await fetch(`${h.server.url}/transcript`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  it('serves what a live session actually wrote', async (t) => {
    const h = await startTestServer(t);
    await setRecording(h.server.url, true);
    h.stream().emit({ type: 'open' });
    h.stream().emit({ type: 'final', text: 'persisted line', startSeconds: 0, endSeconds: 1 });
    await h.drain();

    const entries = (await (await fetch(`${h.server.url}/transcript`)).json()) as TranscriptEntry[];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.text, 'persisted line');
  });

  it('reads fresh on every request rather than caching', async (t) => {
    const h = await startTestServer(t);
    await h.seed([entry('one', 0)]);
    assert.equal(((await (await fetch(`${h.server.url}/transcript`)).json()) as unknown[]).length, 1);

    await h.seed([entry('two', 1)]);
    assert.equal(((await (await fetch(`${h.server.url}/transcript`)).json()) as unknown[]).length, 2);
  });

  it('returns the NEWEST entries when capped, not the oldest', async (t) => {
    const h = await startTestServer(t);
    await h.seed(Array.from({ length: 10 }, (_, i) => entry(`line ${i}`, i)));

    const entries = (await (
      await fetch(`${h.server.url}/transcript?limit=3`)
    ).json()) as TranscriptEntry[];
    assert.deepEqual(entries.map((e) => e.text), ['line 7', 'line 8', 'line 9']);
  });

  it('clamps an absurd limit rather than reading unbounded', async (t) => {
    const h = await startTestServer(t);
    await h.seed([entry('one', 0)]);
    const response = await fetch(`${h.server.url}/transcript?limit=${MAX_TRANSCRIPT_LIMIT * 10}`);
    assert.equal(response.status, 200);
  });

  it('rejects an incoherent limit', async (t) => {
    const h = await startTestServer(t);
    for (const limit of ['0', '-5', 'abc', '1.5', '']) {
      const response = await fetch(`${h.server.url}/transcript?limit=${limit}`);
      assert.equal(response.status, 400, `limit=${limit} should be rejected`);
    }
  });
});
