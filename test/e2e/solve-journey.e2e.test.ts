import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONFIG_FILE_NAME } from '../../src/host/config/store.ts';
import type { ScreenSolverConfig } from '../../src/host/config/types.ts';
import {
  bootApp,
  EXERCISM_WINDOW,
  LEETCODE_WINDOW,
  USAGE,
  ZERO_USAGE,
  waitUntil,
} from './harness.ts';

/**
 * End-to-end: the paths a user actually walks, driven through the HTTP
 * surface a browser has, against a fully bootstrapped host (see
 * `harness.ts` for exactly what is and isn't faked).
 *
 * Each test names the #25 user stories it stands for. Two families of story
 * are deliberately absent because no HTTP-level test can honestly cover them,
 * and #25's "Explicitly not unit-tested" section says as much:
 *
 * - The answer's *shape* (stories 18-20: heading, one fenced code block, the
 *   `> **Missing:**` line) is a property of the system prompt and the real
 *   model, not of any code here -- a fake provider says whatever the test
 *   tells it to. `test/host/provider.test.ts` covers the seam's normalization;
 *   the prompt contract itself is manual/E2E-verified against real sites.
 * - Everything viewport-driven (stories 29-33: portrait/landscape layout,
 *   rotation, fullscreen feature detection) lives in `static/client/` and
 *   needs a real browser.
 */

describe('e2e: first run, from opening the page to the first answer', () => {
  it('serves the web client, offers the picker, and refuses to solve until a window is chosen (stories 5, 6, 12, 26)', async (t) => {
    const app = await bootApp(t);
    const events = await app.connect(t);

    const page = await fetch(`${app.url}/`);
    assert.equal(page.status, 200, 'the bare server URL serves the client -- what a phone on the same network opens');
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /<html|<!doctype/i);

    const config = await app.getConfig();
    assert.equal(config.targetWindow, null, 'nothing is watched on a cold start');

    assert.deepEqual(
      await app.listWindows(),
      [LEETCODE_WINDOW, EXERCISM_WINDOW],
      'the picker has something to show in place of the answer pane',
    );

    const rejected = await app.solve();
    assert.equal(rejected.status, 400, 'a clear rejection, not a silent no-op');
    assert.deepEqual(await rejected.json(), { error: 'no_target_configured' });

    assert.equal(app.provider.calls.length, 0);
    assert.equal(await events.raceTimeout(150), 'timeout', 'a rejected solve emits no SSE traffic at all');
    assert.deepEqual(await app.readUsageLog(), [], 'and costs nothing, since no call was ever attempted');
  });

  it('picking a window opens exactly one capture session and tells every connected client at once (stories 9, 13)', async (t) => {
    const app = await bootApp(t);
    const desktop = await app.connect(t);
    const phone = await app.connect(t);

    assert.deepEqual(app.sessionsOpened, [], 'no session is held before a target exists');

    const response = await app.setTarget(LEETCODE_WINDOW);
    assert.equal(response.status, 200);

    const [desktopFrame] = await desktop.take(1);
    const [phoneFrame] = await phone.take(1);
    assert.equal(desktopFrame?.type, 'config');
    assert.deepEqual(desktopFrame?.target, LEETCODE_WINDOW);
    assert.deepEqual(phoneFrame, desktopFrame, 'no client is left watching a stale target');

    await waitUntil(() => app.sessionsOpened.length === 1, 'the capture session opens on the pick itself');
    assert.deepEqual(app.sessionsOpened, [LEETCODE_WINDOW]);
    assert.equal(app.sessionsClosed.count(), 0);
  });

  it('the whole happy path: 202, a streamed answer, one answers.jsonl line and one matching usage.jsonl line (stories 10, 17, 22, 25)', async (t) => {
    const app = await bootApp(t);
    await app.setTarget(LEETCODE_WINDOW);
    await waitUntil(() => app.sessionsOpened.length === 1, 'the capture session is open');

    const events = await app.connect(t);

    const accepted = await app.solve();
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { status: 'accepted' });

    const call = await app.provider.waitForCall(1);
    assert.deepEqual(
      call.image,
      { mediaType: 'image/jpeg', bytes: new Uint8Array([137, 80, 78, 71]) },
      'the model is handed the frame the held session produced, uncropped',
    );

    call.push({ type: 'delta', text: '# Two Sum\n\n' });
    call.push({ type: 'delta', text: '```python\ndef two_sum(nums, target):\n    ...\n```\n\n' });
    call.push({ type: 'delta', text: 'A single pass with a seen-value map, O(n) time and O(n) space.' });
    call.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });

    const frames = await events.take(5);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['start', 'delta', 'delta', 'delta', 'done'],
      'the answer arrives incrementally, not in one lump at the end',
    );
    assert.equal(frames[1]?.text, '# Two Sum\n\n');
    assert.deepEqual(frames[4]?.usage, USAGE);

    const [answer] = await app.waitForAnswerLines(1);
    assert.equal(answer?.title, 'Two Sum');
    assert.equal(
      answer?.text,
      '# Two Sum\n\n```python\ndef two_sum(nums, target):\n    ...\n```\n\nA single pass with a seen-value map, O(n) time and O(n) space.',
      'the persisted answer is the final text, not the delta history',
    );
    assert.equal(answer?.model, app.model);
    assert.deepEqual(answer?.usage, USAGE);
    assert.deepEqual(answer?.target, LEETCODE_WINDOW);
    assert.equal(answer?.interrupted, undefined);
    assert.ok(!Number.isNaN(Date.parse(answer!.timestamp)));

    const usage = await app.readUsageLog();
    assert.equal(usage.length, 1, 'every attempted call is accounted for');
    assert.equal(usage[0]?.outcome, 'done');
    assert.equal(usage[0]?.bail, undefined);
    assert.deepEqual(usage[0]?.usage, USAGE);
    assert.equal(usage[0]?.model, app.model);

    assert.deepEqual(
      await app.getAnswers(),
      await app.readAnswerLog(),
      'GET /answers is the same backlog, fetched independently of the live connection',
    );
  });
});

describe('e2e: the held capture session', () => {
  it('is held across repeated solves rather than re-grabbed per click, so the capture border never flickers (story 13)', async (t) => {
    const app = await bootApp(t);
    await app.setTarget(LEETCODE_WINDOW);
    await waitUntil(() => app.sessionsOpened.length === 1, 'the capture session is open');

    for (let i = 1; i <= 3; i += 1) {
      const response = await app.solve();
      assert.equal(response.status, 202);
      const call = await app.provider.waitForCall(i);
      call.answer(`# Two Sum\nattempt ${i}`);
      await app.waitForAnswerLines(i);
    }

    assert.equal(app.frameGrabs.count(), 3, 'three solves really did grab three frames');
    assert.deepEqual(app.sessionsOpened, [LEETCODE_WINDOW], 'from exactly one session, opened once');
    assert.equal(app.sessionsClosed.count(), 0, 'and never closed and reopened in between');
  });

  it('a target change tears the old session down and opens the new one live, with no restart (stories 4, 9, 13)', async (t) => {
    const app = await bootApp(t);
    const events = await app.connect(t);

    await app.setTarget(LEETCODE_WINDOW);
    await waitUntil(() => app.sessionsOpened.length === 1, 'the first session is open');
    await events.take(1);

    await app.setTarget(EXERCISM_WINDOW);

    const [changed] = await events.take(1);
    assert.equal(changed?.type, 'config');
    assert.deepEqual(changed?.target, EXERCISM_WINDOW);

    await waitUntil(() => app.sessionsOpened.length === 2, 'the new target gets its own session');
    assert.deepEqual(app.sessionsOpened, [LEETCODE_WINDOW, EXERCISM_WINDOW]);
    await waitUntil(() => app.sessionsClosed.count() === 1, 'the old session is torn down');

    // The change took effect for real work too, not just on the wire.
    await app.solve();
    await (await app.provider.waitForCall(1)).answer('# Reverse String\nsolved against the new window');
    const [answer] = await app.waitForAnswerLines(1);
    assert.deepEqual(answer?.target, EXERCISM_WINDOW);
  });
});

describe('e2e: interrupt and replace', () => {
  it('a second Solve now is always accepted, and the partial it displaces is kept as interrupted (stories 11, 21, 24)', async (t) => {
    const app = await bootApp(t);
    await app.setTarget(LEETCODE_WINDOW);
    await waitUntil(() => app.sessionsOpened.length === 1, 'the capture session is open');
    const events = await app.connect(t);

    const first = await app.solve();
    assert.equal(first.status, 202);
    const call1 = await app.provider.waitForCall(1);
    call1.push({ type: 'delta', text: '# Two Sum\nhalf an answ' });
    assert.deepEqual((await events.take(2)).map((f) => f.type), ['start', 'delta']);

    const second = await app.solve();
    assert.equal(second.status, 202, 'never blocked by a stale in-flight request');
    const call2 = await app.provider.waitForCall(2);
    assert.equal(call1.signal?.aborted, true, 'the previous answer stopped the moment the new one was asked for');

    call2.answer('# Two Sum\nthe complete answer');

    assert.deepEqual(
      (await events.take(3)).map((f) => f.type),
      ['start', 'delta', 'done'],
      'a fresh start begins immediately -- "interrupted" is never a wire event',
    );

    const answers = await app.waitForAnswerLines(2);
    assert.equal(answers[0]?.interrupted, true);
    assert.equal(answers[0]?.text, '# Two Sum\nhalf an answ', 'the partial is kept, not discarded');
    assert.deepEqual(answers[0]?.usage, ZERO_USAGE, 'an interrupted call reports no real token counts');
    assert.equal(answers[1]?.interrupted, undefined);
    assert.equal(answers[1]?.text, '# Two Sum\nthe complete answer');

    const usage = await app.waitForUsageLines(2);
    assert.deepEqual(
      usage.map((entry) => entry.outcome),
      ['interrupted', 'done'],
      'both attempts are visible for cost purposes',
    );
  });
});

describe('e2e: two devices at once', () => {
  it('a phone joining mid-answer is caught up with sync{text} and then tracks the desktop exactly (stories 23, 26, 27, 28)', async (t) => {
    const app = await bootApp(t);
    await app.setTarget(LEETCODE_WINDOW);
    await waitUntil(() => app.sessionsOpened.length === 1, 'the capture session is open');

    const desktop = await app.connect(t);

    await app.solve();
    const call = await app.provider.waitForCall(1);
    call.push({ type: 'delta', text: '# Two Sum\n' });
    call.push({ type: 'delta', text: 'the first half' });
    assert.deepEqual((await desktop.take(3)).map((f) => f.type), ['start', 'delta', 'delta']);

    // The phone unlocks late -- or reconnects after the screen locked, which
    // `EventSource` does on its own and the server treats identically.
    const phone = await app.connect(t);
    const [sync] = await phone.take(1);
    assert.equal(sync?.type, 'sync', 'a mid-flight join gets sync, not start, and not a history replay');
    assert.equal(sync?.text, '# Two Sum\nthe first half', 'carrying everything it missed');

    call.push({ type: 'delta', text: ' and the second' });
    call.push({ type: 'done', usage: USAGE, stopReason: 'end_turn' });

    const [desktopTail, phoneTail] = await Promise.all([desktop.take(2), phone.take(2)]);
    assert.deepEqual(desktopTail, phoneTail, 'neither client is more current than the other');
    assert.deepEqual(desktopTail.map((f) => f.type), ['delta', 'done']);

    await app.waitForAnswerLines(1);
  });

  it('a client that connects between answers gets no sync, and reads history over GET /answers instead (stories 22, 23)', async (t) => {
    const app = await bootApp(t);
    await app.setTarget(LEETCODE_WINDOW);
    await waitUntil(() => app.sessionsOpened.length === 1, 'the capture session is open');

    const desktop = await app.connect(t);
    await app.solve();
    (await app.provider.waitForCall(1)).answer('# Two Sum\nan answer that finished before the phone woke up');
    assert.deepEqual((await desktop.take(3)).map((f) => f.type), ['start', 'delta', 'done']);
    await app.waitForAnswerLines(1);

    const phone = await app.connect(t);

    const backlog = await app.getAnswers();
    assert.equal(backlog.length, 1, 'what it missed comes from GET /answers, once, on page load');
    assert.equal(backlog[0]?.title, 'Two Sum');

    // Nothing is in flight, so the first frame this connection ever sees is a
    // real `start` -- proof it got no `sync` catch-up, without leaving a
    // stray pending read racing for that same frame.
    await app.solve();
    (await app.provider.waitForCall(2)).answer('# Two Sum\nthe next one');
    const [frame] = await phone.take(1);
    assert.equal(frame?.type, 'start');
    await phone.take(2); // delta, done -- drained so nothing is pending when the connection is cancelled
    await desktop.take(3);
    await app.waitForAnswerLines(2);
  });
});

describe('e2e: restarting the app', () => {
  it('re-finds the saved window by process name + title and keeps the whole answer history (stories 3, 7, 22)', async (t) => {
    const first = await bootApp(t);
    await first.setTarget(LEETCODE_WINDOW);
    await waitUntil(() => first.sessionsOpened.length === 1, 'the capture session is open');

    await first.solve();
    (await first.provider.waitForCall(1)).answer('# Two Sum\nsolved before the restart');
    await first.waitForAnswerLines(1);
    await first.shutdown();

    // Same `%APPDATA%`, brand new process -- and deliberately no memory of
    // any OS window handle, since handles don't survive a restart.
    const second = await bootApp(t, { stateRoot: first.stateRoot });

    assert.deepEqual(
      (await second.getConfig()).targetWindow,
      LEETCODE_WINDOW,
      'the saved target is re-resolved against the windows currently open',
    );
    await waitUntil(() => second.sessionsOpened.length === 1, 'and its capture session opens at startup');

    const backlog = await second.getAnswers();
    assert.equal(backlog.length, 1);
    assert.equal(backlog[0]?.text, '# Two Sum\nsolved before the restart');

    // The settings really did come off disk, and solving still works.
    await second.solve();
    (await second.provider.waitForCall(1)).answer('# Two Sum\nsolved after the restart');
    assert.equal((await second.waitForAnswerLines(2)).length, 2);
  });

  it('falls back to the picker when the saved window is gone, without forgetting it on disk (stories 6, 7)', async (t) => {
    const first = await bootApp(t);
    await first.setTarget(LEETCODE_WINDOW);
    await first.shutdown();

    const second = await bootApp(t, { stateRoot: first.stateRoot, windows: [EXERCISM_WINDOW] });

    assert.equal(
      (await second.getConfig()).targetWindow,
      null,
      'nothing matches by process name + title, so the client shows the picker',
    );
    assert.deepEqual(second.sessionsOpened, [], 'and no session is opened for a window that is not there');

    const onDisk = JSON.parse(
      await readFile(join(second.stateRoot, CONFIG_FILE_NAME), 'utf8'),
    ) as ScreenSolverConfig;
    assert.deepEqual(
      onDisk.targetWindow,
      LEETCODE_WINDOW,
      'the saved identity survives, so the same window resolves again on a later run without re-picking',
    );

    const rejected = await second.solve();
    assert.equal(rejected.status, 400);
  });
});
