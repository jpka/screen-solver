import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StartupError } from '../../src/host/errors.ts';
import { silentLogger } from '../../src/host/logger.ts';
import { createHostRoutes } from '../../src/host/http/routes.ts';
import { startHttpServer } from '../../src/host/http/server.ts';

const LOOPBACK = '127.0.0.1';

async function startOnEphemeralPort(t: import('node:test').TestContext) {
  const server = await startHttpServer({
    binding: { host: LOOPBACK, port: 0 },
    routes: createHostRoutes().routes,
    logger: silentLogger,
  });
  t.after(() => server.close());
  return server;
}

describe('startHttpServer', () => {
  it('listens and reports the port it actually bound', async (t) => {
    const server = await startOnEphemeralPort(t);

    assert.ok(server.port > 0);
    assert.equal(server.url, `http://${LOOPBACK}:${server.port}`);
  });

  it('serves the health route', async (t) => {
    const server = await startOnEphemeralPort(t);

    const response = await fetch(`${server.url}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'screen-solver' });
  });

  it('404s an unknown route instead of hanging', async (t) => {
    const server = await startOnEphemeralPort(t);

    const response = await fetch(`${server.url}/nope`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });

  it('refuses to start when the port is already occupied', async (t) => {
    const occupant = await startOnEphemeralPort(t);

    await assert.rejects(
      () =>
        startHttpServer({
          binding: { host: LOOPBACK, port: occupant.port },
          routes: createHostRoutes().routes,
          logger: silentLogger,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.equal(error.kind, 'port-unavailable');
        assert.match(error.message, new RegExp(`${occupant.port}`));
        assert.match(error.message, /already in use/);
        return true;
      },
    );
  });

  it('reports a 500 rather than crashing when a route throws', async (t) => {
    const server = await startHttpServer({
      binding: { host: LOOPBACK, port: 0 },
      routes: [
        {
          method: 'GET',
          path: '/boom',
          handle: () => {
            throw new Error('kaboom');
          },
        },
      ],
      logger: silentLogger,
    });
    t.after(() => server.close());

    const response = await fetch(`${server.url}/boom`);

    assert.equal(response.status, 500);
  });
});
