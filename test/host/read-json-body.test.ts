import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { MAX_JSON_BODY_BYTES, PayloadTooLargeError, readJsonBody } from '../../src/host/http/router.ts';

/**
 * `readJsonBody`'s own unit suite -- everything else in this repo exercises
 * request bodies indirectly through a real HTTP client (`web-client-http.test.ts`'s
 * `POST /config/target` tests), which can't reliably force a socket `error`
 * event to fire at the exact moment this module is mid-drain of an oversized
 * body. That specific race is exactly what the #33 PR review flagged (a
 * second `error` after the oversized-body branch had already removed its
 * only listener used to crash the whole host process, not just fail the
 * request) -- a fake `IncomingMessage`-shaped `EventEmitter` can force that
 * ordering directly, which real HTTP can't.
 */

/** Minimal `IncomingMessage` stand-in: `readJsonBody` only ever calls `.on()`/`.removeListener()`/`.resume()` on it. */
function fakeRequest(): IncomingMessage & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { resume: () => emitter }) as unknown as IncomingMessage & EventEmitter;
}

describe('readJsonBody', () => {
  it('resolves null for an empty body', async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req);
    req.emit('end');
    assert.equal(await promise, null);
  });

  it('resolves the parsed body for well-formed JSON split across chunks', async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req);
    req.emit('data', Buffer.from('{"processName":"chrome.exe",'));
    req.emit('data', Buffer.from('"title":"Two Sum"}'));
    req.emit('end');
    assert.deepEqual(await promise, { processName: 'chrome.exe', title: 'Two Sum' });
  });

  it('rejects with the JSON parse error for malformed input', async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req);
    req.emit('data', Buffer.from('{not json'));
    req.emit('end');
    await assert.rejects(promise, SyntaxError);
  });

  it('rejects with PayloadTooLargeError once accumulated bytes cross the cap, without buffering the rest', async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req, 10);
    req.emit('data', Buffer.from('12345678901')); // 11 bytes, over the 10-byte cap
    await assert.rejects(promise, PayloadTooLargeError);
  });

  it(
    'does not crash the process when the request errors after the oversized-body drain has already begun ' +
      '(#33 PR review fix: the drain branch used to leave the request with zero error listeners at this point)',
    async () => {
      const req = fakeRequest();
      const promise = readJsonBody(req, 10);

      req.emit('data', Buffer.from('12345678901')); // trips the cap, settle() removes the real onError
      await assert.rejects(promise, PayloadTooLargeError, 'the oversized rejection itself still happens');

      // The regression: without the fix, this `emit('error', ...)` call
      // would find zero listeners left on `req` and Node's EventEmitter
      // would throw synchronously right here, which -- uncaught in the
      // real server -- takes the whole host process down. The fix's
      // baseline listener means this line simply doesn't throw.
      assert.doesNotThrow(() => req.emit('error', new Error('client disconnected mid-drain')));
    },
  );

  it('rejects with the underlying error when the request errors before any data arrives', async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req);
    const boom = new Error('socket reset');
    req.emit('error', boom);
    await assert.rejects(promise, (error: unknown) => error === boom);
  });

  it('defaults to MAX_JSON_BODY_BYTES when no explicit cap is passed', async () => {
    const req = fakeRequest();
    const promise = readJsonBody(req);
    req.emit('data', Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 'x'));
    await assert.rejects(promise, PayloadTooLargeError);
  });
});
