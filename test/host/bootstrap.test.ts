import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { describe, it, type TestContext } from 'node:test';
import { API_KEY_ENV_VAR } from '../../src/host/api-key.ts';
import { HTTP_HOST_ENV_VAR, HTTP_PORT_ENV_VAR } from '../../src/host/binding.ts';
import { apiKeyIsOutOfEnvironment, bootstrapHost } from '../../src/host/bootstrap.ts';
import { StartupError } from '../../src/host/errors.ts';
import { silentLogger, type Logger } from '../../src/host/logger.ts';
import { startHttpServer } from '../../src/host/http/server.ts';
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
});
