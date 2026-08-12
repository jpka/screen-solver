import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRecordingCoordinator,
  type RecordingCoordinatorDeps,
  type RecordingState,
} from '../../src/host/audio/recording-coordinator.ts';
import type {
  AudioChunkSink,
  OpenAudioCapture,
  Transcriber,
  TranscriberStream,
  TranscriptChannel,
  TranscriptEvent,
} from '../../src/host/audio/types.ts';
import { createTranscriptWindow } from '../../src/host/audio/window.ts';
import type { TranscriptLog } from '../../src/host/logs/transcript-log.ts';
import type { TranscriptEntry } from '../../src/host/logs/types.ts';

const SOCKET_OPENED_AT = new Date('2026-08-11T09:00:00.000Z');
/** A "now" a few seconds into the fixture session, so window assertions don't race the real clock. */
const DURING_SESSION = SOCKET_OPENED_AT.getTime() + 10_000;

interface FakeStream extends TranscriberStream {
  readonly channel: TranscriptChannel;
  readonly pcm: Uint8Array[];
  closeCalls: number;
  emit(event: TranscriptEvent): void;
}

interface FakeCapture {
  closeCalls: number;
  push(channel: TranscriptChannel, pcm: Uint8Array): void;
}

interface Harness {
  readonly deps: RecordingCoordinatorDeps;
  readonly streams: FakeStream[];
  readonly appended: TranscriptEntry[];
  readonly broadcast: TranscriptEntry[];
  readonly interims: { channel: TranscriptChannel; text: string }[];
  readonly states: RecordingState[];
  readonly captures: FakeCapture[];
  stream(channel: TranscriptChannel): FakeStream;
  capture(): FakeCapture;
}

function harness(
  options: {
    withTranscriber?: boolean;
    withCapture?: boolean;
    captureThrows?: boolean;
    appendThrows?: boolean;
  } = {},
): Harness {
  const streams: FakeStream[] = [];
  const captures: FakeCapture[] = [];
  const appended: TranscriptEntry[] = [];
  const broadcast: TranscriptEntry[] = [];
  const interims: { channel: TranscriptChannel; text: string }[] = [];
  const states: RecordingState[] = [];

  const transcriber: Transcriber = {
    model: 'nova-3',
    open({ channel, onEvent }) {
      const stream: FakeStream = {
        channel,
        pcm: [],
        closeCalls: 0,
        send(pcm) {
          stream.pcm.push(pcm);
        },
        async close() {
          stream.closeCalls += 1;
        },
        emit: onEvent,
      };
      streams.push(stream);
      return stream;
    },
  };

  const openAudioCapture: OpenAudioCapture = async (sink: AudioChunkSink) => {
    if (options.captureThrows === true) throw new Error('no audio device');
    const capture: FakeCapture = {
      closeCalls: 0,
      push: (channel, pcm) => sink({ channel, pcm }),
    };
    captures.push(capture);
    return {
      async close() {
        capture.closeCalls += 1;
      },
    };
  };

  const transcriptLog = {
    async append(entry: TranscriptEntry) {
      if (options.appendThrows === true) throw new Error('disk is full');
      appended.push(entry);
    },
    async readAll() {
      return appended;
    },
  } satisfies TranscriptLog;

  return {
    deps: {
      transcriber: options.withTranscriber === false ? undefined : transcriber,
      openAudioCapture: options.withCapture === false ? undefined : openAudioCapture,
      transcriptLog,
      transcriptWindow: createTranscriptWindow(),
      onTranscript: (entry) => broadcast.push(entry),
      onInterim: (channel, text) => interims.push({ channel, text }),
      onStateChange: (state) => states.push(state),
      now: () => SOCKET_OPENED_AT,
      newSessionId: (() => {
        let n = 0;
        return () => `session-${(n += 1)}`;
      })(),
    },
    streams,
    captures,
    appended,
    broadcast,
    interims,
    states,
    stream(channel) {
      const found = streams.find((s) => s.channel === channel);
      assert.ok(found !== undefined, `no stream opened for channel "${channel}"`);
      return found;
    },
    capture() {
      const found = captures[captures.length - 1];
      assert.ok(found !== undefined, 'no capture was opened');
      return found;
    },
  };
}

describe('createRecordingCoordinator', () => {
  describe('availability', () => {
    it('reports unavailable and opens nothing when there is no transcriber', async () => {
      const h = harness({ withTranscriber: false });
      const coordinator = createRecordingCoordinator(h.deps);

      assert.equal(coordinator.state(), 'unavailable');
      assert.equal(await coordinator.start(), 'unavailable');
      assert.equal(h.streams.length, 0);
      assert.equal(h.captures.length, 0);
    });

    it('reports unavailable when there is no capture opener', async () => {
      const h = harness({ withCapture: false });
      const coordinator = createRecordingCoordinator(h.deps);

      assert.equal(coordinator.state(), 'unavailable');
      assert.equal(await coordinator.start(), 'unavailable');
      assert.equal(h.streams.length, 0);
    });

    it('starts off when fully wired', () => {
      const h = harness();
      assert.equal(createRecordingCoordinator(h.deps).state(), 'off');
    });
  });

  describe('starting and stopping', () => {
    it('opens exactly one capture and one stream per recorded channel', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();

      assert.equal(h.captures.length, 1);
      assert.deepEqual(h.streams.map((s) => s.channel), ['them']);
    });

    it('is starting until the socket reports itself open, then on', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      assert.equal(coordinator.state(), 'starting');

      h.stream('them').emit({ type: 'open' });
      assert.equal(coordinator.state(), 'on');
      assert.deepEqual(h.states, ['starting', 'on']);
    });

    it('mints a fresh session id per start', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      assert.equal(coordinator.sessionId(), 'session-1');

      await coordinator.stop();
      assert.equal(coordinator.sessionId(), null);

      await coordinator.start();
      assert.equal(coordinator.sessionId(), 'session-2');
    });

    it('a second start while already recording is a no-op, never a second set of sockets', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      h.stream('them').emit({ type: 'open' });

      await coordinator.start();
      await coordinator.start();

      assert.equal(h.streams.length, 1);
      assert.equal(h.captures.length, 1);
    });

    it('two overlapping starts still open only one session', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await Promise.all([coordinator.start(), coordinator.start()]);

      assert.equal(h.streams.length, 1);
      assert.equal(h.captures.length, 1);
    });

    it('stop() closes the capture and every stream, and returns to off', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      h.stream('them').emit({ type: 'open' });
      await coordinator.stop();

      assert.equal(h.capture().closeCalls, 1);
      assert.equal(h.stream('them').closeCalls, 1);
      assert.equal(coordinator.state(), 'off');
    });

    it('stop() on a coordinator that never started does nothing', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.stop();
      assert.equal(coordinator.state(), 'off');
      assert.equal(h.captures.length, 0);
    });

    it('goes to error and tears down when audio capture cannot be opened', async () => {
      const h = harness({ captureThrows: true });
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();

      assert.equal(coordinator.state(), 'error');
      // The streams that were already opened must not be left dangling.
      assert.equal(h.stream('them').closeCalls, 1);
    });
  });

  describe('routing audio', () => {
    it('sends each chunk to the stream for its own channel', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();

      h.capture().push('them', new Uint8Array([1, 2]));
      h.capture().push('them', new Uint8Array([3, 4]));

      assert.deepEqual(h.stream('them').pcm, [new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    });

    it('drops a chunk for a channel this session did not open, rather than throwing in the audio callback', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();

      assert.doesNotThrow(() => h.capture().push('me', new Uint8Array([9])));
      assert.equal(h.stream('them').pcm.length, 0);
    });
  });

  describe('transcript events', () => {
    it('persists, broadcasts, and windows exactly one entry per final', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      const stream = h.stream('them');
      stream.emit({ type: 'open' });

      stream.emit({ type: 'final', text: 'reverse a linked list', startSeconds: 2, endSeconds: 4 });
      await coordinator.drain();

      assert.equal(h.appended.length, 1);
      assert.equal(h.broadcast.length, 1);
      assert.deepEqual(h.appended[0], {
        recordingSessionId: 'session-1',
        channel: 'them',
        text: 'reverse a linked list',
        // The socket opened at 09:00:00 and the segment ends 4s in.
        timestamp: '2026-08-11T09:00:04.000Z',
        startSeconds: 2,
        endSeconds: 4,
        model: 'nova-3',
      });
      assert.equal(h.deps.transcriptWindow?.render(DURING_SESSION), 'Them: reverse a linked list');
    });

    it('broadcasts an interim without persisting or windowing it', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      const stream = h.stream('them');
      stream.emit({ type: 'open' });

      stream.emit({ type: 'interim', text: 'reverse a link' });
      await coordinator.drain();

      assert.deepEqual(h.interims, [{ channel: 'them', text: 'reverse a link' }]);
      assert.equal(h.appended.length, 0);
      assert.equal(h.deps.transcriptWindow?.render(DURING_SESSION), null);
    });

    it('writes in call order even when finals arrive back to back', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      const stream = h.stream('them');
      stream.emit({ type: 'open' });

      for (const text of ['one', 'two', 'three', 'four']) {
        stream.emit({ type: 'final', text, startSeconds: 0, endSeconds: 1 });
      }
      await coordinator.drain();

      assert.deepEqual(h.appended.map((e) => e.text), ['one', 'two', 'three', 'four']);
    });

    it('one failed append does not wedge the chain for later lines', async () => {
      const h = harness({ appendThrows: true });
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      const stream = h.stream('them');
      stream.emit({ type: 'open' });

      stream.emit({ type: 'final', text: 'first', startSeconds: 0, endSeconds: 1 });
      stream.emit({ type: 'final', text: 'second', startSeconds: 1, endSeconds: 2 });

      // The whole point: drain() still resolves rather than rejecting or hanging.
      await coordinator.drain();
      assert.equal(h.broadcast.length, 2, 'the wire is unaffected by a disk failure');
    });

    it('moves to reconnecting and back to on across a dropped socket', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      const stream = h.stream('them');
      stream.emit({ type: 'open' });

      stream.emit({ type: 'reconnecting', attempt: 1 });
      assert.equal(coordinator.state(), 'reconnecting');

      stream.emit({ type: 'open' });
      assert.equal(coordinator.state(), 'on');
      assert.deepEqual(h.states, ['starting', 'on', 'reconnecting', 'on']);
    });

    it('goes to error on a rejected key', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();

      h.stream('them').emit({ type: 'error', kind: 'auth', message: 'bad key' });
      assert.equal(coordinator.state(), 'error');
    });

    it('clears the solve window when recording stops, so the next session starts clean', async () => {
      const h = harness();
      const coordinator = createRecordingCoordinator(h.deps);
      await coordinator.start();
      const stream = h.stream('them');
      stream.emit({ type: 'open' });
      stream.emit({ type: 'final', text: 'last session', startSeconds: 0, endSeconds: 1 });
      await coordinator.drain();

      await coordinator.stop();
      assert.equal(h.deps.transcriptWindow?.render(DURING_SESSION), null);
    });
  });
});
