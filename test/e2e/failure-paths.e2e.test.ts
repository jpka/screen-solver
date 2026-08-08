import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, type TestContext } from 'node:test';
import { API_KEY_ENV_VAR } from '../../src/host/api-key.ts';
import { HTTP_HOST_ENV_VAR, HTTP_PORT_ENV_VAR } from '../../src/host/binding.ts';
import { bootstrapHost } from '../../src/host/bootstrap.ts';
import { StartupError } from '../../src/host/errors.ts';
import { silentLogger } from '../../src/host/logger.ts';
import { BAIL_TITLE } from '../../src/host/logs/title.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';
import {
  API_KEY,
  BLACK_FRAME,
  EXERCISM_WINDOW,
  LEETCODE_WINDOW,
  USAGE,
  ZERO_USAGE,
  bootApp,
  flush,
  waitUntil,
  type E2EApp,
} from './harness.ts';

/**
 * End-to-end coverage of #25's failure taxonomy table -- who spends a call,
 * what reaches the wire, and what lands in each log -- plus the two refusals
 * to start. Same rig as `solve-journey.e2e.test.ts`: the whole host, driven
 * only through HTTP.
 *
 * One row of that table has no honest test here: "transient error, retried
 * and recovered". Retrying happens *inside* the provider seam, so from this
 * side a recovered call is indistinguishable from one that never failed --
 * asserting it at the HTTP level would be asserting on the fake. It belongs
 * to the spec's "Secondary seam", and `test/host/provider.test.ts` covers it
 * against a fake Anthropic transport (rate limit, overload, network failure,
 * truncated stream -- each retried with no `error` on the wire; `auth` and
 * `refusal` surfaced on first occurrence).
 */

const LOOPBACK = '127.0.0.1';

/** Boots an app with a target already picked and its capture session open -- the state every failure below starts from. */
async function readyApp(t: TestContext): Promise<E2EApp> {
  const app = await bootApp(t);
  await app.setTarget(LEETCODE_WINDOW);
  await waitUntil(() => app.sessionsOpened.length === 1, 'the capture session is open');
  return app;
}

describe('e2e: pre-flight guards are a silent no-spend', () => {
  it('a minimized target never reaches the model, emits nothing, and is billed nothing (story 15)', async (t) => {
    const app = await readyApp(t);
    const events = await app.connect(t);
    app.setMinimized(true);

    const response = await app.solve();
    assert.equal(response.status, 202, 'the guard runs after the response, not before it');

    await app.minimizedChecks.waitFor(1);
    await flush();

    assert.equal(app.frameGrabs.count(), 0, 'not even a frame is grabbed');
    assert.equal(app.provider.calls.length, 0);
    assert.equal(await events.raceTimeout(150), 'timeout', 'no SSE event -- a button flash is the whole surface');
    assert.deepEqual(await app.readUsageLog(), [], 'no call was attempted, so nothing is recorded');
    assert.deepEqual(await app.readAnswerLog(), []);
  });

  it('a black or zero-size frame is caught before the model is called (story 16)', async (t) => {
    const app = await readyApp(t);
    const events = await app.connect(t);
    app.setFrame(BLACK_FRAME);

    const response = await app.solve();
    assert.equal(response.status, 202);

    await app.frameGrabs.waitFor(1);
    await flush();

    assert.equal(app.provider.calls.length, 0, 'a transient rendering glitch costs nothing');
    assert.equal(await events.raceTimeout(150), 'timeout');
    assert.deepEqual(await app.readUsageLog(), []);

    // And it is not a latch: the next good frame solves normally.
    app.setFrame({ ...BLACK_FRAME, quality: 'ok' });
    await app.solve();
    (await app.provider.waitForCall(1)).answer('# Two Sum\nrecovered');
    assert.equal((await app.waitForAnswerLines(1)).length, 1);
  });

  it('a target that vanished mid-run gets one silent re-resolution, then falls back to the picker (story 8)', async (t) => {
    const app = await readyApp(t);
    const events = await app.connect(t);

    app.setWindows([EXERCISM_WINDOW]); // the watched window is gone from enumeration
    const enumerationsBefore = app.enumerations.count();

    const response = await app.solve();
    assert.equal(response.status, 202);

    await waitUntil(
      async () => (await app.getConfig()).targetWindow === null,
      'the app falls back to the picker after re-resolution fails',
    );

    assert.equal(
      app.enumerations.count() - enumerationsBefore,
      2,
      'exactly one re-resolution attempt beyond the first check -- a transient loss would have recovered silently',
    );
    assert.equal(app.provider.calls.length, 0, 'no call is spent either way');
    assert.deepEqual(await app.readUsageLog(), []);

    const [frame] = await events.take(1);
    assert.equal(frame?.type, 'config');
    assert.equal(frame?.target, null, 'every client is switched to the picker live');

    await waitUntil(() => app.sessionsClosed.count() === 1, 'the now-pointless capture session is torn down');
  });

  it('a target that reappears on the re-check is solved normally, with no interruption to the session (story 8)', async (t) => {
    const app = await readyApp(t);

    // Gone on the first check, back on the second -- the transient loss the
    // re-resolution exists for.
    app.setWindowsSequence([[EXERCISM_WINDOW], [LEETCODE_WINDOW, EXERCISM_WINDOW]]);

    const response = await app.solve();
    assert.equal(response.status, 202);

    const call = await app.provider.waitForCall(1);
    call.answer('# Two Sum\nsolved after a blink');

    assert.deepEqual(
      (await app.getConfig()).targetWindow,
      LEETCODE_WINDOW,
      'a transient loss never interrupts a working session',
    );
    assert.equal((await app.waitForAnswerLines(1)).length, 1);
  });
});

describe('e2e: the model answers, but there is nothing to solve', () => {
  it('a bail is a normal stream that is recorded for cost but kept out of the answer history (stories 19, 24, 25)', async (t) => {
    const app = await readyApp(t);
    const events = await app.connect(t);

    await app.solve();
    const call = await app.provider.waitForCall(1);
    call.push({ type: 'delta', text: `# ${BAIL_TITLE}\n` });
    call.push({ type: 'delta', text: 'This screen has no coding exercise on it.' });
    call.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });

    assert.deepEqual(
      (await events.take(4)).map((f) => f.type),
      ['start', 'delta', 'delta', 'done'],
      'a bail is an ordinary done stream -- the client renders it low-emphasis off the heading',
    );

    const usage = await app.waitForUsageLines(1);
    assert.equal(usage[0]?.outcome, 'done');
    assert.equal(usage[0]?.bail, true, 'flagged as a bail, since it still spent a real call');
    assert.deepEqual(usage[0]?.usage, USAGE);

    assert.deepEqual(await app.readAnswerLog(), [], 'history stays a list of actual answers');
    assert.deepEqual(await app.getAnswers(), []);
  });
});

describe('e2e: provider failures', () => {
  it('a revoked key surfaces as error{kind:auth}, flips the status pill sticky, and prints one console line (stories 34, 38)', async (t) => {
    const app = await readyApp(t);
    const events = await app.connect(t);

    await app.solve();
    const call = await app.provider.waitForCall(1);
    call.push({ type: 'delta', text: '# Two Sum\n' });
    call.fail('auth', 'authentication_error');

    const frames = await events.take(4);
    assert.deepEqual(frames.map((f) => f.type), ['start', 'delta', 'error', 'status']);
    assert.equal(frames[2]?.kind, 'auth');
    assert.deepEqual(
      { level: frames[3]?.level, kind: frames[3]?.kind },
      { level: 'sticky', kind: 'auth' },
      'it will keep failing on every future click, so the indicator stays up',
    );

    const stickyLines = app.consoleLines.filter((line) => line.includes('STICKY'));
    assert.equal(stickyLines.length, 1, 'exactly one line for whoever is watching the terminal');
    assert.equal(
      app.consoleLines.some((line) => line.includes(API_KEY)),
      false,
      'and the key itself is never logged (story 2)',
    );

    const usage = await app.waitForUsageLines(1);
    assert.equal(usage[0]?.outcome, 'error');
    assert.equal(usage[0]?.errorKind, 'auth');
    assert.deepEqual(usage[0]?.usage, ZERO_USAGE, 'an attempted call with no answer has no real token counts');
    assert.deepEqual(await app.readAnswerLog(), [], 'a failed solve never clutters the history');

    // A client opening later learns about the standing problem immediately.
    const phone = await app.connect(t);
    const [first] = await phone.take(1);
    assert.deepEqual(
      { type: first?.type, level: first?.level, kind: first?.kind },
      { type: 'status', level: 'sticky', kind: 'auth' },
    );
  });

  it('a stream that dies mid-answer leaves the partial text standing with an error marker after it (stories 36, 37)', async (t) => {
    const app = await readyApp(t);
    const events = await app.connect(t);

    await app.solve();
    const call = await app.provider.waitForCall(1);
    call.push({ type: 'delta', text: '# Two Sum\n' });
    call.push({ type: 'delta', text: '```python\ndef two_sum(' });
    // `transient` reaching a caller means the seam already retried and gave
    // up -- the retry itself is the seam's own business (`provider.test.ts`).
    call.fail('transient', 'connection reset');

    const frames = await events.take(4);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['start', 'delta', 'delta', 'error'],
      'nothing already streamed is withdrawn -- the error is appended to it',
    );
    assert.equal(frames[3]?.kind, 'transient');

    const [status] = await events.take(1);
    assert.deepEqual(
      { level: status?.level, kind: status?.kind },
      { level: 'auto-recovering', kind: 'transient' },
      'a blip is auto-recovering, not sticky',
    );
    assert.equal(
      app.consoleLines.some((line) => line.includes('STICKY')),
      false,
    );

    const usage = await app.waitForUsageLines(1);
    assert.equal(usage[0]?.errorKind, 'transient');
    assert.deepEqual(await app.readAnswerLog(), []);
  });

  it('a later success clears the standing status for every client (story 38)', async (t) => {
    const app = await readyApp(t);
    const events = await app.connect(t);

    await app.solve();
    (await app.provider.waitForCall(1)).fail('auth');
    await events.take(3); // start, error, status{sticky}

    await app.solve();
    (await app.provider.waitForCall(2)).answer('# Two Sum\nthe key works again');

    const frames = await events.take(4);
    assert.deepEqual(frames.map((f) => f.type), ['start', 'delta', 'done', 'status']);
    assert.deepEqual({ level: frames[3]?.level, kind: frames[3]?.kind }, { level: 'silent', kind: null });

    await app.waitForAnswerLines(1);
  });
});

describe('e2e: refusing to start', () => {
  it('refuses to start with no ANTHROPIC_API_KEY, and binds no port (story 1)', async (t) => {
    const stateRoot = await tempStateRoot(t);

    await assert.rejects(
      () =>
        bootstrapHost({
          env: { [HTTP_HOST_ENV_VAR]: LOOPBACK, [HTTP_PORT_ENV_VAR]: '0' },
          stateRoot,
          acquireInstanceLock: () => true,
          logger: silentLogger,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.equal(error.kind, 'missing-api-key');
        return true;
      },
    );
  });

  it('refuses to start when the port is already taken, rather than letting clients fail silently (story 35)', async (t) => {
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, LOOPBACK, resolve));
    const address = squatter.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    t.after(() => new Promise<void>((resolve) => squatter.close(() => resolve())));

    const stateRoot = await tempStateRoot(t);

    await assert.rejects(
      () =>
        bootstrapHost({
          env: {
            [API_KEY_ENV_VAR]: API_KEY,
            [HTTP_HOST_ENV_VAR]: LOOPBACK,
            [HTTP_PORT_ENV_VAR]: String(port),
          },
          stateRoot,
          acquireInstanceLock: () => true,
          logger: silentLogger,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.equal(error.kind, 'port-unavailable');
        return true;
      },
    );
  });

  it('keeps the API key out of the environment and off every client-facing surface (story 2)', async (t) => {
    const app = await readyApp(t);

    assert.equal(
      API_KEY_ENV_VAR in app.env,
      false,
      'the key is taken out of the environment during startup, before anything could inherit it',
    );
    assert.equal(app.host.apiKey.reveal(), API_KEY, 'it lives in host-process memory and nowhere else');

    await app.solve();
    (await app.provider.waitForCall(1)).answer('# Two Sum\nan answer');
    await app.waitForAnswerLines(1);

    const bodies = await Promise.all(
      ['/', '/config', '/windows', '/answers', '/health'].map(async (path) =>
        (await fetch(`${app.url}${path}`)).text(),
      ),
    );
    for (const body of bodies) {
      assert.equal(body.includes(API_KEY), false, 'no HTTP response ever carries the key');
    }

    const onDisk = [...(await app.readAnswerLog()), ...(await app.readUsageLog())];
    assert.equal(
      JSON.stringify(onDisk).includes(API_KEY),
      false,
      'and nothing written under the state root does either',
    );
  });
});

describe('e2e: shutting down', () => {
  it('stops accepting solves and persists the answer that was in flight (stories 21, 22)', async (t) => {
    const app = await readyApp(t);
    const events = await app.connect(t);

    await app.solve();
    const call = await app.provider.waitForCall(1);
    call.push({ type: 'delta', text: '# Two Sum\nstill streaming when the user quit' });
    // Wait for the delta on the wire, so the loop demonstrably has the text
    // before shutdown aborts the stream out from under it.
    assert.deepEqual((await events.take(2)).map((f) => f.type), ['start', 'delta']);

    await app.shutdown();

    const answers = await app.readAnswerLog();
    assert.equal(answers.length, 1, 'the partial was written on the way out, not abandoned');
    assert.equal(answers[0]?.interrupted, true);
    assert.equal(answers[0]?.text, '# Two Sum\nstill streaming when the user quit');

    await assert.rejects(() => fetch(`${app.url}/health`), 'the server really did stop listening');
  });
});
