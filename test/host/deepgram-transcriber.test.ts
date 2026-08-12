import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDeepgramTranscriber,
  type DeepgramTranscriberConfig,
} from '../../src/host/audio/deepgram.ts';
import {
  CLOSE_CODE_AUDIO_REJECTED,
  CLOSE_CODE_SERVER_ERROR,
  type DeepgramSocket,
} from '../../src/host/audio/deepgram-transport.ts';
import type { TranscriptEvent } from '../../src/host/audio/types.ts';
import { createSecret } from '../../src/host/secret.ts';

const KEY = createSecret('dg-secret-key');

/** Lets the transcriber's own async work (the fetch pre-flight, a 0ms reconnect) run. */
function settle(times = 3): Promise<void> {
  return new Promise((resolve) => {
    let left = times;
    const step = (): void => {
      left -= 1;
      if (left <= 0) resolve();
      else setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

interface FakeSocket extends DeepgramSocket {
  readonly sent: (string | Uint8Array)[];
  readonly url: string;
  readonly headers: Record<string, string>;
  closeCalls: number;
  emitOpen(): void;
  emitRaw(raw: string): void;
  emitMessage(message: unknown): void;
  emitClose(code?: number, reason?: string): void;
  emitError(message: string): void;
  /** Every text frame sent, decoded — the KeepAlive/CloseStream control channel. */
  control(): { type?: string }[];
}

interface Harness {
  readonly config: Pick<
    DeepgramTranscriberConfig,
    'apiKey' | 'openSocket' | 'fetch' | 'reconnectDelaysMs'
  >;
  readonly sockets: FakeSocket[];
  readonly authCalls: { url: string; headers: Record<string, string>; body: unknown }[];
  latest(): FakeSocket;
}

function harness(options: { authStatus?: number; authThrows?: boolean } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const authCalls: Harness['authCalls'] = [];

  const openSocket = (url: string, headers: Record<string, string>): FakeSocket => {
    const handlers: {
      open: (() => void)[];
      message: ((raw: string) => void)[];
      close: ((code: number, reason: string) => void)[];
      error: ((message: string) => void)[];
    } = { open: [], message: [], close: [], error: [] };

    const socket: FakeSocket = {
      sent: [],
      url,
      headers,
      closeCalls: 0,
      send(data) {
        socket.sent.push(data);
      },
      close() {
        socket.closeCalls += 1;
      },
      onOpen(handler) {
        handlers.open.push(handler);
      },
      onMessage(handler) {
        handlers.message.push(handler);
      },
      onClose(handler) {
        handlers.close.push(handler);
      },
      onError(handler) {
        handlers.error.push(handler);
      },
      emitOpen() {
        for (const handler of handlers.open) handler();
      },
      emitRaw(raw) {
        for (const handler of handlers.message) handler(raw);
      },
      emitMessage(message) {
        socket.emitRaw(JSON.stringify(message));
      },
      emitClose(code = 1000, reason = '') {
        for (const handler of handlers.close) handler(code, reason);
      },
      emitError(message) {
        for (const handler of handlers.error) handler(message);
      },
      control() {
        return socket.sent
          .filter((frame): frame is string => typeof frame === 'string')
          .map((frame) => JSON.parse(frame) as { type?: string });
      },
    };

    sockets.push(socket);
    return socket;
  };

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    authCalls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    if (options.authThrows === true) throw new Error('network is down');
    return new Response(null, { status: options.authStatus ?? 200 });
  }) as typeof globalThis.fetch;

  return {
    config: { apiKey: KEY, openSocket, fetch: fakeFetch, reconnectDelaysMs: [0] },
    sockets,
    authCalls,
    latest: () => {
      const socket = sockets[sockets.length - 1];
      assert.ok(socket !== undefined, 'expected a socket to have been opened');
      return socket;
    },
  };
}

/** A `Results` frame in Deepgram's shape. */
function results(transcript: string, isFinal: boolean, start = 0, duration = 0): unknown {
  return {
    type: 'Results',
    is_final: isFinal,
    start,
    duration,
    channel: { alternatives: [{ transcript }] },
  };
}

function collect(): { events: TranscriptEvent[]; onEvent: (e: TranscriptEvent) => void } {
  const events: TranscriptEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

describe('createDeepgramTranscriber', () => {
  describe('the connection', () => {
    it('opens a listen socket with the parameters the renderer actually produces', async () => {
      const h = harness();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent: () => {} });
      await settle();

      const url = new URL(h.latest().url);
      assert.equal(url.protocol, 'wss:');
      assert.equal(url.host, 'api.deepgram.com');
      assert.equal(url.pathname, '/v1/listen');
      assert.equal(url.searchParams.get('model'), 'nova-3');
      assert.equal(url.searchParams.get('encoding'), 'linear16');
      assert.equal(url.searchParams.get('sample_rate'), '16000');
      assert.equal(url.searchParams.get('channels'), '1');
      assert.equal(url.searchParams.get('interim_results'), 'true');
    });

    it('authenticates with a Token header, and the key still redacts if anything logs the headers', async () => {
      const h = harness();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent: () => {} });
      await settle();

      assert.equal(h.latest().headers['authorization'], 'Token dg-secret-key');
      // The Secret itself must never be the thing that leaks -- the header is a
      // deliberate `.reveal()`, but the holder stays redacted.
      assert.equal(JSON.stringify({ apiKey: KEY }), '{"apiKey":"[redacted]"}');
    });

    it('reports the model it transcribes with', () => {
      const h = harness();
      assert.equal(createDeepgramTranscriber(h.config).model, 'nova-3');
    });

    it('announces the connection so a caller can move off "starting"', async () => {
      const h = harness();
      const { events, onEvent } = collect();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();
      h.latest().emitOpen();

      assert.deepEqual(events, [{ type: 'open' }]);
    });
  });

  describe('the key pre-flight', () => {
    it('refuses to open any socket at all when the key is rejected', async () => {
      const h = harness({ authStatus: 401 });
      const { events, onEvent } = collect();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();

      assert.equal(h.sockets.length, 0);
      assert.equal(events.length, 1);
      assert.deepEqual(
        events[0] === undefined ? null : { type: events[0].type, kind: 'kind' in events[0] ? events[0].kind : null },
        { type: 'error', kind: 'auth' },
      );
    });

    it('checks the key exactly once, against the auth grant endpoint', async () => {
      const h = harness();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent: () => {} });
      await settle();

      assert.equal(h.authCalls.length, 1);
      assert.equal(h.authCalls[0]?.url, 'https://api.deepgram.com/v1/auth/grant');
      assert.equal(
        (h.authCalls[0]?.headers as Record<string, string>)['authorization'],
        'Token dg-secret-key',
      );
    });

    it('proceeds on a 403, because a streaming-scoped key can be refused by that endpoint and still work', async () => {
      const h = harness({ authStatus: 403 });
      const { events, onEvent } = collect();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();

      assert.equal(h.sockets.length, 1);
      assert.equal(events.filter((e) => e.type === 'error').length, 0);
    });

    it('proceeds when the pre-flight itself fails, degrading to no pre-flight rather than a false refusal', async () => {
      const h = harness({ authThrows: true });
      const { events, onEvent } = collect();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();

      assert.equal(h.sockets.length, 1);
      assert.equal(events.filter((e) => e.type === 'error').length, 0);
    });
  });

  describe('transcript messages', () => {
    it('maps a non-final result to interim and a final one to final, with offsets', async () => {
      const h = harness();
      const { events, onEvent } = collect();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();
      const socket = h.latest();
      socket.emitOpen();

      socket.emitMessage(results('reverse a linked', false, 3.5, 1.25));
      socket.emitMessage(results('reverse a linked list', true, 3.5, 1.75));

      assert.deepEqual(events.slice(1), [
        { type: 'interim', text: 'reverse a linked' },
        { type: 'final', text: 'reverse a linked list', startSeconds: 3.5, endSeconds: 5.25 },
      ]);
    });

    it('drops empty transcripts, which Deepgram emits across silence', async () => {
      const h = harness();
      const { events, onEvent } = collect();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();
      const socket = h.latest();
      socket.emitOpen();

      socket.emitMessage(results('', true));
      socket.emitMessage(results('   ', true));
      socket.emitMessage(results('', false));

      assert.equal(events.filter((e) => e.type === 'final' || e.type === 'interim').length, 0);
    });

    it('ignores frames it cannot read instead of ending the recording', async () => {
      const h = harness();
      const { events, onEvent } = collect();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();
      const socket = h.latest();
      socket.emitOpen();

      socket.emitRaw('not json at all');
      socket.emitMessage({ type: 'Metadata', request_id: 'abc' });
      socket.emitMessage({ type: 'SpeechStarted' });
      socket.emitMessage({ type: 'UtteranceEnd', last_word_end: 4.2 });
      socket.emitMessage(results('still working', true, 1, 1));

      assert.deepEqual(events.slice(1), [
        { type: 'final', text: 'still working', startSeconds: 1, endSeconds: 2 },
      ]);
    });
  });

  describe('sending audio', () => {
    it('sends chunks straight through once the socket is open', async () => {
      const h = harness();
      const stream = createDeepgramTranscriber(h.config).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      const socket = h.latest();
      socket.emitOpen();

      stream.send(new Uint8Array([1, 2]));
      stream.send(new Uint8Array([3, 4]));

      assert.deepEqual(
        socket.sent.filter((f) => f instanceof Uint8Array),
        [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
      );
    });

    it('buffers audio that arrives before the socket opens, then replays it in order', async () => {
      const h = harness();
      const stream = createDeepgramTranscriber(h.config).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      const socket = h.latest();

      stream.send(new Uint8Array([1]));
      stream.send(new Uint8Array([2]));
      stream.send(new Uint8Array([3]));
      assert.equal(socket.sent.length, 0, 'nothing should reach a socket that is not open yet');

      socket.emitOpen();
      assert.deepEqual(
        socket.sent.filter((f) => f instanceof Uint8Array),
        [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
      );
    });

    it('drops the OLDEST buffered audio once the bound is reached', async () => {
      const h = harness();
      const stream = createDeepgramTranscriber({ ...h.config, maxBufferedBytes: 4 }).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      const socket = h.latest();

      stream.send(new Uint8Array([1, 1]));
      stream.send(new Uint8Array([2, 2]));
      stream.send(new Uint8Array([3, 3]));
      socket.emitOpen();

      // An honest gap at the old end beats a flood of stale audio.
      assert.deepEqual(
        socket.sent.filter((f) => f instanceof Uint8Array),
        [new Uint8Array([2, 2]), new Uint8Array([3, 3])],
      );
    });
  });

  describe('keepalive', () => {
    it('sends KeepAlive frames on the interval so Deepgram does not drop an idle socket', async () => {
      const h = harness();
      createDeepgramTranscriber({ ...h.config, keepaliveIntervalMs: 5 }).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      h.latest().emitOpen();

      await new Promise((resolve) => setTimeout(resolve, 40));
      const keepalives = h.latest().control().filter((frame) => frame.type === 'KeepAlive');
      assert.ok(keepalives.length >= 2, `expected repeated keepalives, saw ${keepalives.length}`);
    });

    it('stops the keepalive once the stream is closed', async () => {
      const h = harness();
      const stream = createDeepgramTranscriber({ ...h.config, keepaliveIntervalMs: 5 }).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      const socket = h.latest();
      socket.emitOpen();
      await new Promise((resolve) => setTimeout(resolve, 15));

      const closing = stream.close();
      socket.emitClose(1000, '');
      await closing;

      const before = socket.control().filter((f) => f.type === 'KeepAlive').length;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const after = socket.control().filter((f) => f.type === 'KeepAlive').length;
      assert.equal(after, before);
    });
  });

  describe('reconnecting', () => {
    it('opens a fresh socket after an unexpected close', async () => {
      const h = harness();
      const { events, onEvent } = collect();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();
      h.latest().emitOpen();

      h.latest().emitClose(CLOSE_CODE_SERVER_ERROR, 'NET-0001');
      assert.deepEqual(
        events.filter((e) => e.type === 'reconnecting'),
        [{ type: 'reconnecting', attempt: 1 }],
      );

      await settle();
      assert.equal(h.sockets.length, 2);
    });

    it('replays buffered audio onto the new socket, in order', async () => {
      const h = harness();
      const stream = createDeepgramTranscriber(h.config).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      const first = h.latest();
      first.emitOpen();
      first.emitClose(CLOSE_CODE_SERVER_ERROR, 'NET-0001');

      // Audio keeps arriving from the device while the socket is down.
      stream.send(new Uint8Array([7]));
      stream.send(new Uint8Array([8]));

      await settle();
      const second = h.latest();
      assert.notEqual(second, first);
      second.emitOpen();

      assert.deepEqual(
        second.sent.filter((f) => f instanceof Uint8Array),
        [new Uint8Array([7]), new Uint8Array([8])],
      );
    });

    it('never reconnects after Deepgram rejects the audio format', async () => {
      const h = harness();
      const { events, onEvent } = collect();
      createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();
      h.latest().emitOpen();

      h.latest().emitClose(CLOSE_CODE_AUDIO_REJECTED, 'DATA-0000');
      await settle();

      // Our own parameters are wrong; another socket would fail identically.
      assert.equal(h.sockets.length, 1);
      const error = events.find((e) => e.type === 'error');
      assert.equal(error?.type === 'error' ? error.kind : null, 'audio-rejected');
      assert.equal(events.some((e) => e.type === 'reconnecting'), false);
    });

    it('stops reconnecting once the stream is closed', async () => {
      const h = harness();
      const stream = createDeepgramTranscriber(h.config).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      const socket = h.latest();
      socket.emitOpen();

      const closing = stream.close();
      socket.emitClose(1000, '');
      await closing;
      await settle();

      assert.equal(h.sockets.length, 1);
    });
  });

  describe('closing', () => {
    it('asks Deepgram to flush the trailing finals before closing', async () => {
      const h = harness();
      const { events, onEvent } = collect();
      const stream = createDeepgramTranscriber(h.config).open({ channel: 'them', onEvent });
      await settle();
      const socket = h.latest();
      socket.emitOpen();

      const closing = stream.close();
      assert.ok(
        socket.control().some((frame) => frame.type === 'CloseStream'),
        'CloseStream should go out synchronously with close()',
      );

      // The last thing said before shutdown still arrives.
      socket.emitMessage(results('one last sentence', true, 9, 1));
      socket.emitClose(1000, '');
      await closing;

      assert.ok(events.some((e) => e.type === 'final' && e.text === 'one last sentence'));
      assert.equal(socket.closeCalls, 1);
    });

    it('resolves anyway when the socket never closes back', async () => {
      const h = harness();
      const stream = createDeepgramTranscriber({ ...h.config, closeTimeoutMs: 10 }).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      h.latest().emitOpen();

      // This is the property shutdown depends on: a wedged socket must not be
      // able to eat bootstrap.ts's whole drain budget.
      const started = Date.now();
      await stream.close();
      assert.ok(Date.now() - started < 1_000);
      assert.equal(h.latest().closeCalls, 1);
    });

    it('is safe to close a stream whose socket never opened', async () => {
      const h = harness();
      const stream = createDeepgramTranscriber(h.config).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      await stream.close();
      assert.equal(h.latest().closeCalls, 1);
    });

    it('ignores audio sent after close', async () => {
      const h = harness();
      const stream = createDeepgramTranscriber(h.config).open({
        channel: 'them',
        onEvent: () => {},
      });
      await settle();
      const socket = h.latest();
      socket.emitOpen();
      const closing = stream.close();
      socket.emitClose(1000, '');
      await closing;

      const before = socket.sent.length;
      stream.send(new Uint8Array([9, 9]));
      assert.equal(socket.sent.length, before);
    });
  });
});
