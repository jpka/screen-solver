import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createStaticRoutes } from '../../src/host/http/static.ts';
import { startHttpServer, type ListeningHttpServer } from '../../src/host/http/server.ts';
import { silentLogger } from '../../src/host/logger.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

/** A throwaway directory of real static files, the same shape `static/client/` has -- real fs, no fakes, matching this repo's own testing style (`solve-http.test.ts` et al. run real HTTP against real dependencies wherever the alternative is a fake that doesn't earn its keep). */
async function writeFixture(t: TestContext): Promise<string> {
  const dir = await tempStateRoot(t);
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>fixture</title>');
  await writeFile(join(dir, 'app.js'), 'console.log("hi");');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'nested.css'), 'body { color: red; }');
  return dir;
}

async function serve(t: TestContext, dir: string): Promise<ListeningHttpServer> {
  const routes = await createStaticRoutes({ dir });
  const server = await startHttpServer({ binding: { host: '127.0.0.1', port: 0 }, routes, logger: silentLogger });
  t.after(() => server.close());
  return server;
}

describe('createStaticRoutes', () => {
  it('serves a top-level file at its own path with a content-type derived from the extension', async (t) => {
    const dir = await writeFixture(t);
    const server = await serve(t, dir);

    const response = await fetch(`${server.url}/app.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/javascript/);
    assert.equal(await response.text(), 'console.log("hi");');
  });

  it('serves index.html at both /index.html and / (bare server URL)', async (t) => {
    const dir = await writeFixture(t);
    const server = await serve(t, dir);

    for (const path of ['/index.html', '/']) {
      const response = await fetch(`${server.url}${path}`);
      assert.equal(response.status, 200, `GET ${path}`);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.equal(await response.text(), '<!doctype html><title>fixture</title>');
    }
  });

  it('serves a nested file at its relative path with forward slashes, regardless of OS path separators', async (t) => {
    const dir = await writeFixture(t);
    const server = await serve(t, dir);

    const response = await fetch(`${server.url}/sub/nested.css`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(await response.text(), 'body { color: red; }');
  });

  it('answers 404 for a path outside the served set', async (t) => {
    const dir = await writeFixture(t);
    const server = await serve(t, dir);

    const response = await fetch(`${server.url}/does-not-exist.js`);
    assert.equal(response.status, 404);
  });

  it('falls back to application/octet-stream for an unrecognized extension', async (t) => {
    const dir = await tempStateRoot(t);
    await writeFile(join(dir, 'data.bin'), Buffer.from([1, 2, 3]));
    const server = await serve(t, dir);

    const response = await fetch(`${server.url}/data.bin`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  });

  it('sends no-store, so a rebuilt client is never served stale from a browser cache', async (t) => {
    const dir = await writeFixture(t);
    const server = await serve(t, dir);

    const response = await fetch(`${server.url}/app.js`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
