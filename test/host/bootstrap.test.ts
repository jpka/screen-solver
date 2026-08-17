import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { API_KEY_ENV_VAR, DEEPGRAM_API_KEY_ENV_VAR } from '../../src/host/api-key.ts';
import type {
  OpenAudioCapture,
  Transcriber,
  TranscriberStream,
  TranscriptEvent,
} from '../../src/host/audio/types.ts';
import { HTTP_HOST_ENV_VAR, HTTP_PORT_ENV_VAR } from '../../src/host/binding.ts';
import {
  apiKeyIsOutOfEnvironment,
  bootstrapHost,
  deepgramKeyIsOutOfEnvironment,
} from '../../src/host/bootstrap.ts';
import { TRANSCRIPT_LOG_FILE_NAME } from '../../src/host/logs/transcript-log.ts';
import type { TranscriptEntry } from '../../src/host/logs/types.ts';
import type { CapturedFrame } from '../../src/host/capture/types.ts';
import { CONFIG_FILE_NAME } from '../../src/host/config/store.ts';
import type { TargetWindowIdentity } from '../../src/host/config/types.ts';
import { StartupError } from '../../src/host/errors.ts';
import { silentLogger, type Logger } from '../../src/host/logger.ts';
import { startHttpServer } from '../../src/host/http/server.ts';
import { createAnswerLog } from '../../src/host/logs/answer-log.ts';
import type { Provider, SolveEvent } from '../../src/host/provider/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

const KEY = 'sk-ant-test-bootstrap';
const LOOPBACK = '127.0.0.1';

/** Grab a port the OS just told us is free, then hand it back. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, LOOPBACK, resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => void lines.push(m),
    warn: (m) => void lines.push(m),
    error: (m) => void lines.push(m),
  };
}

/** A deferred promise, for synchronizing a test with a point it knows the code under test reached -- no arbitrary sleeps. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Scenario {
  env: NodeJS.ProcessEnv;
  stateRoot: string;
  lockAcquired: boolean;
  serverStarts: number;
}

async function scenario(
  t: TestContext,
  overrides: Partial<Scenario> & { stateRootExists?: boolean } = {},
): Promise<Scenario> {
  return {
    env: overrides.env ?? {
      [API_KEY_ENV_VAR]: KEY,
      [HTTP_HOST_ENV_VAR]: LOOPBACK,
      [HTTP_PORT_ENV_VAR]: '0',
    },
    stateRoot:
      overrides.stateRoot ?? (await tempStateRoot(t, { created: overrides.stateRootExists })),
    lockAcquired: overrides.lockAcquired ?? true,
    serverStarts: 0,
  };
}

function runtimeFor(s: Scenario, logger: Logger = silentLogger) {
  return {
    env: s.env,
    stateRoot: s.stateRoot,
    acquireInstanceLock: () => s.lockAcquired,
    logger,
    startHttpServer: (options: Parameters<typeof startHttpServer>[0]) => {
      s.serverStarts += 1;
      return startHttpServer(options);
    },
  };
}

describe('bootstrapHost', () => {
  it('refuses to start without ANTHROPIC_API_KEY, and binds nothing', async (t) => {
    const s = await scenario(t, {
      env: { [HTTP_HOST_ENV_VAR]: LOOPBACK, [HTTP_PORT_ENV_VAR]: '0' },
    });

    await assert.rejects(
      () => bootstrapHost(runtimeFor(s)),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.equal(error.kind, 'missing-api-key');
        assert.match(error.message, /ANTHROPIC_API_KEY is not set/);
        return true;
      },
    );

    assert.equal(s.serverStarts, 0, 'no port is bound when startup is refused');
  });

  it('starts with the key set, and the key is gone from the environment afterwards', async (t) => {
    const s = await scenario(t);

    const result = await bootstrapHost(runtimeFor(s));
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    assert.equal(apiKeyIsOutOfEnvironment(s.env), true);
    assert.equal(API_KEY_ENV_VAR in s.env, false);
    assert.equal(result.host.apiKey.reveal(), KEY, 'the host still holds it in memory');
  });

  it('creates the state root when it is missing', async (t) => {
    const s = await scenario(t, { stateRootExists: false });

    await assert.rejects(() => stat(s.stateRoot), 'precondition: state root does not exist yet');

    const result = await bootstrapHost(runtimeFor(s));
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    assert.ok((await stat(s.stateRoot)).isDirectory());
    assert.equal(result.host.stateRoot, s.stateRoot);
  });

  it('is a clean no-op when another instance already holds the lock', async (t) => {
    const s = await scenario(t, { lockAcquired: false });

    const result = await bootstrapHost(runtimeFor(s));

    assert.equal(result.status, 'already-running');
    assert.equal(s.serverStarts, 0, 'the second instance binds no port');
    assert.equal(
      API_KEY_ENV_VAR in s.env,
      true,
      'the second instance exits before it even reads the key',
    );
  });

  it('refuses to start when the configured port is already occupied', async (t) => {
    const occupied = await freePort();
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(occupied, LOOPBACK, resolve));
    t.after(() => new Promise<void>((resolve) => squatter.close(() => resolve())));

    const s = await scenario(t, {
      env: {
        [API_KEY_ENV_VAR]: KEY,
        [HTTP_HOST_ENV_VAR]: LOOPBACK,
        [HTTP_PORT_ENV_VAR]: String(occupied),
      },
    });

    await assert.rejects(
      () => bootstrapHost(runtimeFor(s)),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.equal(error.kind, 'port-unavailable');
        assert.match(error.message, /already in use/);
        return true;
      },
    );
  });

  it('leaves an HTTP server listening on its configured port', async (t) => {
    const port = await freePort();
    const s = await scenario(t, {
      env: {
        [API_KEY_ENV_VAR]: KEY,
        [HTTP_HOST_ENV_VAR]: LOOPBACK,
        [HTTP_PORT_ENV_VAR]: String(port),
      },
    });
    const logger = recordingLogger();

    const result = await bootstrapHost(runtimeFor(s, logger));
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    assert.equal(result.host.binding.port, port);

    const response = await fetch(`http://${LOOPBACK}:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'screen-solver' });

    const printed = logger.lines.join('\n');
    assert.match(printed, new RegExp(`${port}`), 'the terminal is told where to connect');
    assert.equal(printed.includes(KEY), false, 'startup logging never carries the key');
  });

  it('stops listening after shutdown', async (t) => {
    const s = await scenario(t);

    const result = await bootstrapHost(runtimeFor(s));
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;

    const { port } = result.host.binding;
    await result.host.shutdown();

    await assert.rejects(() => fetch(`http://${LOOPBACK}:${port}/health`));
  });

  it('wires the config store into StartedHost, with the injected enumerateWindows actually threaded through', async (t) => {
    const s = await scenario(t);
    const injectedWindows = [{ processName: 'chrome.exe', title: 'Two Sum - LeetCode' }];

    const result = await bootstrapHost({
      ...runtimeFor(s),
      enumerateWindows: async () => injectedWindows,
    });
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    assert.deepEqual(result.host.configStore.get(), { targetWindow: null, provider: null, contextPath: null });
    assert.deepEqual(
      await result.host.configStore.listWindows(),
      injectedWindows,
      'listWindows() reaches the enumerateWindows passed into bootstrapHost, not some other default',
    );
  });

  it('defaults to no windows when enumerateWindows is left unset, per its documented fallback', async (t) => {
    const s = await scenario(t);

    const result = await bootstrapHost(runtimeFor(s));
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    assert.deepEqual(await result.host.configStore.listWindows(), []);
  });

  it('opens a capture session at startup for a target already resolved by the config store', async (t) => {
    const s = await scenario(t);
    const target = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };
    // Pre-seed config.json with a saved target, the same way #28's config
    // suite simulates a restart -- so the config store resolves it as the
    // *live* target before bootstrapHost ever returns.
    await writeFile(
      join(s.stateRoot, CONFIG_FILE_NAME),
      JSON.stringify({ targetWindow: target, provider: null }),
    );
    const opened: unknown[] = [];

    const result = await bootstrapHost({
      ...runtimeFor(s),
      enumerateWindows: async () => [target],
      openCaptureSession: async (openedTarget) => {
        opened.push(openedTarget);
        return {
          captureFrame: async (): Promise<never> => {
            throw new Error('not exercised');
          },
          close: async () => {},
        };
      },
    });
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    assert.deepEqual(result.host.configStore.get().targetWindow, target, 'precondition: resolved at load');

    await result.host.captureSessionCoordinator.settled();

    assert.deepEqual(opened, [target], 'a session opens at startup, not deferred to the first solve');
    assert.deepEqual(result.host.captureSessionCoordinator.currentTarget(), target);
  });

  it('never opens a capture session when no target is configured, per the documented safe default', async (t) => {
    const s = await scenario(t);

    const result = await bootstrapHost(runtimeFor(s));
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    await result.host.captureSessionCoordinator.settled();
    assert.equal(result.host.captureSessionCoordinator.currentTarget(), null);
  });

  it('shutdown waits for an in-flight solve to finish persisting before closing resources (#40 review fix)', async (t) => {
    const s = await scenario(t);
    const target: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };
    await writeFile(
      join(s.stateRoot, CONFIG_FILE_NAME),
      JSON.stringify({ targetWindow: target, provider: null }),
    );

    const frame: CapturedFrame = {
      mediaType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
      width: 1200,
      height: 800,
      quality: 'ok',
    };

    // A single-call provider whose terminal event is pushed by hand, so the
    // test can race `shutdown()` against the still-in-flight write it
    // triggers -- the exact race the #40 review comment flagged.
    let resolvePushDoneReady!: (push: () => void) => void;
    const pushDoneReady = new Promise<() => void>((resolve) => {
      resolvePushDoneReady = resolve;
    });
    const provider: Provider = {
      model: 'fake-model',
      solve(): AsyncIterable<SolveEvent> {
        return {
          [Symbol.asyncIterator]() {
            let sent = false;
            return {
              async next(): Promise<IteratorResult<SolveEvent>> {
                if (sent) return { value: undefined, done: true };
                await new Promise<void>((resolve) => {
                  resolvePushDoneReady(resolve);
                });
                sent = true;
                return {
                  value: {
                    type: 'done',
                    usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
                    stopReason: 'end_turn',
                  },
                  done: false,
                };
              },
            };
          },
        };
      },
    };

    const result = await bootstrapHost({
      ...runtimeFor(s),
      provider,
      enumerateWindows: async () => [target],
      isTargetMinimized: async () => false,
      openCaptureSession: async () => ({
        captureFrame: async () => frame,
        close: async () => {},
      }),
    });
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;

    await result.host.captureSessionCoordinator.settled();

    const response = await fetch(`http://${LOOPBACK}:${result.host.binding.port}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);

    const pushDone = await pushDoneReady;

    // Resolve the provider's terminal event and, in the same breath, start
    // shutdown -- without the fix, `shutdown()` would race ahead and close
    // resources before `onOutcome`'s JSONL write ever lands.
    pushDone();
    await result.host.shutdown();

    const entries = await createAnswerLog({ stateRoot: s.stateRoot }).readAll();
    assert.equal(entries.length, 1, 'the in-flight answer was persisted, not abandoned mid-write by shutdown');
  });

  it('shutdown gives up on a solve that ignores its abort rather than hanging forever (#40 review fix)', async (t) => {
    const s = await scenario(t);
    const target: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };
    await writeFile(
      join(s.stateRoot, CONFIG_FILE_NAME),
      JSON.stringify({ targetWindow: target, provider: null }),
    );

    const frame: CapturedFrame = {
      mediaType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
      width: 1200,
      height: 800,
      quality: 'ok',
    };

    // The pathological provider: its stream never ends and it never checks
    // the `AbortSignal`, so aborting the attempt does nothing. Real-world
    // stand-in for a wedged socket -- the case `settled()`/`stop()` alone
    // can't get out of, which is why shutdown bounds the wait.
    const started = deferred();
    const provider: Provider = {
      model: 'fake-model',
      solve(): AsyncIterable<SolveEvent> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<SolveEvent>> {
                started.resolve();
                return new Promise<IteratorResult<SolveEvent>>(() => {});
              },
            };
          },
        };
      },
    };

    const logger = recordingLogger();
    const result = await bootstrapHost({
      ...runtimeFor(s, logger),
      provider,
      solveDrainTimeoutMs: 50,
      enumerateWindows: async () => [target],
      isTargetMinimized: async () => false,
      openCaptureSession: async () => ({
        captureFrame: async () => frame,
        close: async () => {},
      }),
    });
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;

    await result.host.captureSessionCoordinator.settled();

    const response = await fetch(`http://${LOOPBACK}:${result.host.binding.port}/solve`, { method: 'POST' });
    assert.equal(response.status, 202);
    await started.promise;

    // The assertion is simply that this resolves at all -- before the fix it
    // awaited the stuck attempt with no bound, and the process stayed up.
    await result.host.shutdown();

    assert.ok(
      logger.lines.some((line) => line.includes('without waiting any longer')),
      'giving up on the drain is reported, not silent',
    );
    await assert.rejects(
      () => fetch(`http://${LOOPBACK}:${result.host.binding.port}/health`),
      'the server really did close, rather than shutdown returning early with teardown left undone',
    );
  });
});

describe('bootstrapHost: recording', () => {
  /** A transcriber whose one stream the test drives by hand, plus a capture that produces nothing. */
  function fakeAudio(): {
    transcriber: Transcriber;
    openAudioCapture: OpenAudioCapture;
    emit(event: TranscriptEvent): void;
    closes(): number;
  } {
    let emit: ((event: TranscriptEvent) => void) | null = null;
    let closes = 0;

    const transcriber: Transcriber = {
      model: 'nova-3',
      open({ onEvent }) {
        emit = onEvent;
        const stream: TranscriberStream = {
          send() {},
          async close() {
            closes += 1;
          },
        };
        return stream;
      },
    };

    return {
      transcriber,
      openAudioCapture: async () => ({ async close() {} }),
      emit: (event) => emit?.(event),
      closes: () => closes,
    };
  }

  it('still starts with no DEEPGRAM_API_KEY -- a missing transcription key is a degraded mode, not a refusal', async (t) => {
    const s = await scenario(t);

    const result = await bootstrapHost(runtimeFor(s));
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    assert.equal(result.host.recordingCoordinator.state(), 'unavailable');
  });

  it('takes DEEPGRAM_API_KEY out of the environment, the same as the Anthropic key', async (t) => {
    const s = await scenario(t, {
      env: {
        [API_KEY_ENV_VAR]: KEY,
        [DEEPGRAM_API_KEY_ENV_VAR]: 'dg-test-key',
        [HTTP_HOST_ENV_VAR]: LOOPBACK,
        [HTTP_PORT_ENV_VAR]: '0',
      },
    });

    // The capture opener is supplied too: a key alone isn't enough to make
    // recording available, since Electron owns the audio device half.
    const result = await bootstrapHost({
      ...runtimeFor(s),
      openAudioCapture: async () => ({ async close() {} }),
    });
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    // The hidden renderer snapshots `process.env` at creation and must never
    // see either key.
    assert.equal(deepgramKeyIsOutOfEnvironment(s.env), true);
    assert.equal(apiKeyIsOutOfEnvironment(s.env), true);
    // A real transcriber was built from the key, so recording is offered.
    assert.equal(result.host.recordingCoordinator.state(), 'off');
  });

  it('is unavailable with a key but no audio capture opener -- both halves are required', async (t) => {
    const s = await scenario(t, {
      env: {
        [API_KEY_ENV_VAR]: KEY,
        [DEEPGRAM_API_KEY_ENV_VAR]: 'dg-test-key',
        [HTTP_HOST_ENV_VAR]: LOOPBACK,
        [HTTP_PORT_ENV_VAR]: '0',
      },
    });

    const result = await bootstrapHost(runtimeFor(s));
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;
    t.after(() => result.host.shutdown());

    assert.equal(result.host.recordingCoordinator.state(), 'unavailable');
    assert.equal(deepgramKeyIsOutOfEnvironment(s.env), true, 'the key is still taken either way');
  });

  it('shutdown stops recording and drains transcript.jsonl inside the bounded phase', async (t) => {
    const s = await scenario(t);
    const audio = fakeAudio();

    const result = await bootstrapHost({
      ...runtimeFor(s),
      transcriber: audio.transcriber,
      openAudioCapture: audio.openAudioCapture,
    });
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;

    await result.host.recordingCoordinator.start();
    audio.emit({ type: 'open' });
    audio.emit({ type: 'final', text: 'said just before quitting', startSeconds: 0, endSeconds: 1 });

    await result.host.shutdown();

    assert.equal(audio.closes(), 1, 'the transcription stream was closed');
    const raw = await readFile(join(s.stateRoot, TRANSCRIPT_LOG_FILE_NAME), 'utf8');
    const entries = raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as TranscriptEntry);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.text, 'said just before quitting');
  });

  it('shutdown gives up rather than hanging when a transcription stream never closes', async (t) => {
    const s = await scenario(t);
    const logger = recordingLogger();

    // A stream whose close() never settles -- the audio analogue of the
    // solve that ignores its abort.
    const wedged: Transcriber = {
      model: 'nova-3',
      open: () => ({ send() {}, close: () => new Promise<void>(() => {}) }),
    };

    const result = await bootstrapHost({
      ...runtimeFor(s, logger),
      transcriber: wedged,
      openAudioCapture: async () => ({ async close() {} }),
      solveDrainTimeoutMs: 50,
    });
    assert.equal(result.status, 'started');
    if (result.status !== 'started') return;

    await result.host.recordingCoordinator.start();

    // The assertion is that this resolves at all.
    await result.host.shutdown();

    assert.ok(
      logger.lines.some((line) => line.includes('without waiting any longer')),
      'giving up on the drain is reported, not silent',
    );
    await assert.rejects(
      () => fetch(`http://${LOOPBACK}:${result.host.binding.port}/health`),
      'the server really did close',
    );
  });
});
