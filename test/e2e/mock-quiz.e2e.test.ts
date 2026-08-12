import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { BAIL_TITLE, NO_QUESTION_TITLE } from '../../src/host/logs/title.ts';
import {
  expectationFor,
  loadMockQuiz,
  problem,
  problemsOfKind,
  quizWindows,
  solveRoute,
  targetWindow,
  type MockQuiz,
  type MockQuizProblem,
  type MockQuizRoute,
} from '../fixtures/mock-quiz/quiz.ts';
import { bootApp, waitUntil, type E2EApp } from './harness.ts';

/**
 * The mock quiz, run against the real host.
 *
 * `test/fixtures/mock-quiz/` holds one quiz covering the three ways a question
 * can reach this app -- on the screen, out of the speakers, or both at once --
 * and this suite walks it the way a person does with the manual rig: put the
 * problem on screen, say the spoken lines out loud, press the button its kind
 * calls for, read what came back. The same fixture drives both, so a problem
 * added for a manual session is automatically in the automated run too.
 *
 * All three kinds are answerable now. A `screen` problem is solved from the
 * screenshot alone; a `voice-about-screen` problem is solved from the
 * screenshot plus a spoken constraint; a `voice` problem is solved from
 * speech alone, through the third route (`/solve/transcript-only`) that needs
 * no target window at all. What stays true of a `voice` problem is that its
 * *other* button -- `/solve/with-transcript`, which still sends the
 * catalogue/call screenshot it is shown -- must still bail with
 * `# No exercise on screen`: the screen is authoritative whenever there is
 * one, and being able to answer speech alone through the dedicated route
 * doesn't relax that. `quiz.ts`'s `expectationFor(problem, route)` is how a
 * test asks "what should pressing THIS route produce for THIS problem"
 * without branching on kind by hand.
 *
 * What this can and cannot prove is worth being blunt about, because a quiz
 * invites the wrong expectation. The provider is faked (`harness.ts`), so
 * nothing here checks whether a *model* answers correctly -- `scriptedAnswer`
 * is what the fake streams, and `expected.mustMention` exists for a human
 * grading a real run. What it does check is everything between the three
 * buttons and the disk: which route carries speech and which never does,
 * which route captures a screenshot and which never does, that the transcript
 * reaching the model is the speech that was actually captured, and that each
 * problem leaves the right pair of log lines behind -- including the bails,
 * which are the outcomes a quiz like this exists to pin down.
 */

/** A minimum-viable PCM block: enough to prove the capture device's chunks reach the transcription stream. */
const PCM_CHUNK = new Uint8Array([0, 1, 0, 2, 0, 3, 0, 4]);

const quiz: MockQuiz = await loadMockQuiz();

/** Boots the app with every quiz window open, so any problem can be put on screen. */
async function bootQuiz(t: TestContext): Promise<E2EApp> {
  return bootApp(t, { windows: quizWindows(quiz) });
}

/** Says every one of this problem's spoken lines, in order, at their own fixture offsets. */
function sayAll(app: E2EApp, entry: MockQuizProblem): void {
  for (const [index, line] of entry.spoken.entries()) {
    const next = entry.spoken[index + 1];
    app.say(line.text, {
      startSeconds: line.atSeconds,
      endSeconds: next === undefined ? line.atSeconds + 4 : next.atSeconds,
    });
  }
}

/**
 * Puts one problem on screen, says its lines, presses `route` (defaulting to
 * the problem's own route), and lets the fake provider answer with whatever
 * `expectationFor(entry, route)` scripts for that combination.
 *
 * Returns the provider call, so a test can assert on exactly what the model
 * was handed. Recording has to already be on for a problem that speaks --
 * deliberately, since "the user forgot to press record" is a real state and
 * one of the tests in this file is about it. `route` is overridable so a test
 * can press a `voice` problem's *other* button (`/solve/with-transcript`) and
 * check the bail that route must still produce, without a second copy of the
 * setup this function already does.
 */
async function ask(
  app: E2EApp,
  entry: MockQuizProblem,
  callIndex: number,
  route: MockQuizRoute = solveRoute(entry),
) {
  await app.setTarget(targetWindow(entry));
  await waitUntil(
    () => app.sessionsOpened.at(-1)?.title === entry.screen.windowTitle,
    `the capture session follows the quiz onto "${entry.screen.windowTitle}"`,
  );

  sayAll(app, entry);

  const response =
    route === '/solve'
      ? await app.solve()
      : route === '/solve/with-transcript'
        ? await app.solveWithTranscript()
        : await app.solveTranscriptOnly();
  assert.equal(response.status, 202, `${entry.id} via ${route} was accepted`);

  const call = await app.provider.waitForCall(callIndex);
  call.answer(expectationFor(entry, route).scriptedAnswer);
  return call;
}

/** The `Them: …` block the fixture's spoken lines should render into. */
function expectedTranscript(entry: MockQuizProblem): string {
  return entry.spoken.map((line) => `Them: ${line.text}`).join('\n');
}

describe('e2e: the mock quiz, screen-only problems', () => {
  it('solves from the screenshot alone, and sends no speech even while a recording session is running', async (t) => {
    const app = await bootQuiz(t);
    const entries = problemsOfKind(quiz, 'screen');
    assert.ok(entries.length > 0, 'the fixture has screen-only problems to run');

    // Recording deliberately on for the whole run. A screen-only problem is
    // pressed with the plain button, and the plain button is contractually
    // silent -- so this is also the regression guard for "speech leaks into an
    // ordinary solve", asserted against a session that genuinely has speech in
    // it rather than against an empty window.
    assert.equal((await app.startRecording()).state, 'on');
    app.say('and while you look at that, here is me talking about something else entirely');

    for (const [index, entry] of entries.entries()) {
      const call = await ask(app, entry, index + 1);

      assert.deepEqual(
        call.image,
        { mediaType: 'image/jpeg', bytes: new Uint8Array([137, 80, 78, 71]) },
        `${entry.id}: the model is handed the captured frame`,
      );
      assert.equal(call.signal?.aborted, false);
      assert.equal(
        'transcript' in (call.options ?? {}),
        false,
        `${entry.id}: a screen-only problem carries no transcript key at all, not an undefined one`,
      );
    }

    const answers = await app.waitForAnswerLines(entries.length);
    assert.deepEqual(
      answers.map((answer) => answer.title),
      entries.map((entry) => entry.expected.title),
      'one answer per problem, in the order they were asked',
    );
    assert.deepEqual(
      answers.map((answer) => answer.target?.title),
      entries.map((entry) => entry.screen.windowTitle),
      'each answer records the window its problem was on',
    );
    for (const answer of answers) {
      assert.equal(answer.withTranscript, undefined, 'and none of them is tagged as carrying speech');
    }
  });
});

describe('e2e: the mock quiz, voice-only problems', () => {
  it('answers the spoken question from speech alone, capturing no frame at all', async (t) => {
    const app = await bootQuiz(t);
    const entry = problem(quiz, 'voice-only-longest-run');
    const events = await app.connect(t);

    const recording = await app.startRecording();
    assert.equal(recording.state, 'on');
    assert.ok(recording.sessionId !== null, 'a recording session groups everything said in it');

    // The capture device's chunks really do reach the transcription stream --
    // the one part of the audio path a scripted `say()` would otherwise skip.
    app.pushAudio(PCM_CHUNK);
    assert.deepEqual(app.transcription.current().chunks, [PCM_CHUNK]);

    const framesGrabbedBefore = app.frameGrabs.count();
    const call = await ask(app, entry, 1);

    assert.equal(call.image, null, 'no screenshot exists for a spoken-only solve');
    assert.equal(
      app.frameGrabs.count(),
      framesGrabbedBefore,
      'the structural proof: /solve/transcript-only never even tries to capture a frame',
    );
    assert.equal(
      call.options?.transcript,
      expectedTranscript(entry),
      'everything said this session reaches the model, oldest line first, speaker-labelled',
    );

    const [answer] = await app.waitForAnswerLines(1);
    assert.equal(answer?.title, entry.expected.title, 'a real question, spoken with no screen up, gets a real answer');
    assert.equal(answer?.target, null, 'no window backs an answer that never looked at one');
    assert.equal(answer?.withTranscript, true);

    const [usage] = await app.waitForUsageLines(1);
    assert.equal(usage?.target, null);
    assert.equal(usage?.bail, undefined, 'a fully-stated spoken question is not a bail');
    assert.equal(usage?.outcome, 'done');
    assert.equal(usage?.withTranscript, true, 'and tagged as having carried speech');

    const lines = await app.waitForTranscriptLines(entry.spoken.length);
    assert.deepEqual(
      lines.map((line) => line.text),
      entry.spoken.map((line) => line.text),
      'every spoken line is persisted verbatim',
    );
    assert.deepEqual(
      new Set(lines.map((line) => line.recordingSessionId)),
      new Set([recording.sessionId]),
      'under the session it was said in',
    );
    assert.deepEqual(
      new Set(lines.map((line) => line.channel)),
      new Set(['them']),
      'on the loopback channel -- this is the other side of the call, not the user',
    );
    assert.equal(lines[0]?.model, app.transcriptionModel);

    // The wire carried the whole problem live, not just the file: the toggle
    // reaching `on`, the target the quiz moved to (set for the screen, even
    // though this route never captures it), every finalized line as it was
    // said, and then the solve itself.
    const frames = await events.take(entry.spoken.length + 6);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ['recording', 'recording', 'config', ...entry.spoken.map(() => 'transcript'), 'start', 'delta', 'done'],
    );
    assert.deepEqual(
      frames.slice(0, 2).map((frame) => frame.state),
      ['starting', 'on'],
    );
    assert.equal(
      (frames[3]?.entry as { text: string } | undefined)?.text,
      entry.spoken[0]?.text,
      'a client watching mid-quiz sees each spoken line the moment it is finalized',
    );

    assert.deepEqual(
      await app.getTranscript(),
      await app.readTranscriptLog(),
      'GET /transcript serves the same backlog a reload would read off disk',
    );
  });

  it('pressed with the screen-carrying button instead, the same voice-only problem still bails on what the screen shows', async (t) => {
    // The guard that the new capability didn't quietly relax the
    // screen-authoritative rule: the catalogue screen still has no exercise
    // on it, so `/solve/with-transcript` -- which sends that screenshot
    // alongside the very same speech `/solve/transcript-only` just answered
    // for real -- must still produce the old marker, not an answer.
    const app = await bootQuiz(t);
    const entry = problem(quiz, 'voice-only-longest-run');

    await app.startRecording();
    const call = await ask(app, entry, 1, '/solve/with-transcript');

    assert.ok((call.image?.bytes.length ?? 0) > 0, 'the screenshot goes out on this route');
    assert.equal(call.options?.transcript, expectedTranscript(entry), 'and so does the speech, in the same request');

    const [usage] = await app.waitForUsageLines(1);
    assert.equal(
      usage?.bail,
      true,
      'answerable-from-speech does not override "the screen is authoritative whenever there is one"',
    );
    assert.equal(usage?.target?.title, entry.screen.windowTitle);
    assert.equal(usage?.withTranscript, true);
    assert.deepEqual(await app.readAnswerLog(), [], 'a bail is not an answer, so answers.jsonl stays empty');
  });

  it('each recording toggle starts a fresh session, and only what was said in it reaches the model', async (t) => {
    // A different screen (a call window, not a catalogue) and a fully-stated
    // spoken problem: the most tempting thing to answer from speech alone --
    // and, on its own route, now the correct thing to do.
    const app = await bootQuiz(t);
    const entry = problem(quiz, 'voice-only-balanced-brackets');

    const first = await app.startRecording();
    await app.stopRecording();
    const second = await app.startRecording();
    assert.notEqual(second.sessionId, first.sessionId, 'each toggle is its own session');

    const call = await ask(app, entry, 1);
    assert.equal(
      call.options?.transcript,
      expectedTranscript(entry),
      "the new session starts from nothing said, so only this problem's lines are sent",
    );

    const [answer] = await app.waitForAnswerLines(1);
    assert.equal(answer?.title, entry.expected.title);
    assert.equal(answer?.target, null);
  });

  it('the no-question voice problem asks nothing a program can answer, and bails on its own route too', async (t) => {
    const app = await bootQuiz(t);
    const entry = problem(quiz, 'voice-only-no-question');
    assert.equal(entry.expected.title, NO_QUESTION_TITLE, 'precondition: this is the fixture entry for the newer marker');

    await app.startRecording();
    const call = await ask(app, entry, 1);
    assert.equal(call.image, null, 'still no screenshot -- small talk doesn`t change what this route sends');

    const [usage] = await app.waitForUsageLines(1);
    assert.equal(usage?.bail, true, 'small talk is not a question, even spoken with nothing on screen either');
    assert.equal(usage?.target, null);
    assert.deepEqual(await app.readAnswerLog(), [], 'a bail is not an answer');
  });

  it('POST /solve/transcript-only refuses when nothing has been said, spending nothing', async (t) => {
    const app = await bootQuiz(t);
    const entry = problem(quiz, 'sum-of-positive');
    await app.setTarget(targetWindow(entry));
    await waitUntil(
      () => app.sessionsOpened.at(-1)?.title === entry.screen.windowTitle,
      'a target is configured, so this is genuinely "nothing said", not "nothing to solve against"',
    );

    const response = await app.solveTranscriptOnly();
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'no_transcript' });

    assert.equal(app.provider.calls.length, 0, 'refused before the provider was ever called');
    assert.deepEqual(await app.readAnswerLog(), [], 'no answer for a call that never happened');
    assert.deepEqual(await app.readUsageLog(), [], 'no usage either -- a refusal is not an attempt');
  });

  it('POST /solve/transcript-only accepts and solves with no target window ever configured', async (t) => {
    // The marquee behavior the third route exists for: a question asked out
    // loud before the picker has ever been touched. Nothing is captured, so
    // nothing needs to be configured first.
    const app = await bootQuiz(t);
    const entry = problem(quiz, 'voice-only-balanced-brackets');
    assert.equal((await app.getConfig()).targetWindow, null, 'nothing has been picked yet');

    await app.startRecording();
    sayAll(app, entry);

    const response = await app.solveTranscriptOnly();
    assert.equal(response.status, 202);

    const call = await app.provider.waitForCall(1);
    assert.equal(call.image, null);
    assert.equal(call.options?.transcript, expectedTranscript(entry));
    call.answer(entry.expected.scriptedAnswer);

    const [answer] = await app.waitForAnswerLines(1);
    assert.equal(answer?.title, entry.expected.title);
    assert.equal(answer?.target, null, 'the answer exists with no window ever having been configured');
  });
});

describe('e2e: the mock quiz, voice problems about what is on screen', () => {
  it('sends the screenshot and the spoken constraint in one request, and logs the answer as transcript-carrying', async (t) => {
    const app = await bootQuiz(t);
    const entry = problem(quiz, 'reverse-string-iteratively');
    await app.startRecording();

    const call = await ask(app, entry, 1);

    assert.deepEqual(
      call.image,
      { mediaType: 'image/jpeg', bytes: new Uint8Array([137, 80, 78, 71]) },
      'the screen is still where the exercise comes from',
    );
    assert.equal(call.options?.transcript, expectedTranscript(entry));
    assert.match(
      call.options?.transcript ?? '',
      /iteratively/,
      'including the constraint that exists nowhere on screen',
    );

    const [answer] = await app.waitForAnswerLines(1);
    assert.equal(answer?.title, entry.expected.title);
    assert.equal(answer?.withTranscript, true, 'the log says this answer was reached with speech in hand');
    assert.deepEqual(answer?.target, targetWindow(entry));

    const [usage] = await app.waitForUsageLines(1);
    assert.equal(usage?.bail, undefined, 'an exercise was on screen, so this is not a bail');
    assert.equal(usage?.withTranscript, true);
  });

  it('only sends what was said before the button, not what is said after it', async (t) => {
    // The window is rendered synchronously with the trigger (`solve/loop.ts`),
    // which is what stops a slow pre-flight from folding in a sentence spoken
    // after the user already asked. The quiz's own two-part questions are
    // exactly the shape that would expose it.
    const app = await bootQuiz(t);
    const entry = problem(quiz, 'two-sum-linear');
    await app.startRecording();
    await app.setTarget(targetWindow(entry));
    await waitUntil(() => app.sessionsOpened.length === 1, 'the capture session is open');

    const [firstLine, secondLine] = entry.spoken;
    assert.ok(firstLine !== undefined && secondLine !== undefined);
    app.say(firstLine.text, { startSeconds: firstLine.atSeconds, endSeconds: secondLine.atSeconds });

    await app.solveWithTranscript();
    const call = await app.provider.waitForCall(1);

    app.say(secondLine.text, {
      startSeconds: secondLine.atSeconds,
      endSeconds: secondLine.atSeconds + 4,
    });
    call.answer(entry.expected.scriptedAnswer);
    await app.waitForAnswerLines(1);

    assert.equal(
      call.options?.transcript,
      `Them: ${firstLine.text}`,
      'the sentence spoken after the press belongs to the next solve, not this one',
    );

    // It is not lost, though -- it is in the window the next press reads.
    await app.solveWithTranscript();
    const second = await app.provider.waitForCall(2);
    assert.equal(second.options?.transcript, expectedTranscript(entry));
    second.answer(entry.expected.scriptedAnswer);
    await app.waitForAnswerLines(2);
  });
});

describe('e2e: the whole mock quiz, start to finish', () => {
  it('walks every problem through its own route and leaves exactly the logs each one calls for', async (t) => {
    const app = await bootQuiz(t);
    await app.startRecording();

    for (const [index, entry] of quiz.problems.entries()) {
      const route = solveRoute(entry);
      const call = await ask(app, entry, index + 1, route);
      assert.equal(
        'transcript' in (call.options ?? {}),
        entry.spoken.length > 0,
        `${entry.id}: asked ${entry.spoken.length > 0 ? 'with' : 'without'} speech, matching whether it says anything`,
      );
      assert.equal(
        call.image === null,
        route === '/solve/transcript-only',
        `${entry.id}: only the spoken-only route (${route}) captures no screenshot`,
      );
    }

    // Every attempt is on the usage log; only the non-bails reach answers.jsonl.
    // The bail count isn't fixed at any particular kind any more -- a `voice`
    // problem's own route can go either way -- so this reads it off the
    // fixture rather than assuming which problems bail.
    const solutions = quiz.problems.filter((entry) => entry.expected.outcome === 'solution');
    const bails = quiz.problems.filter((entry) => entry.expected.outcome === 'bail');
    const usage = await app.waitForUsageLines(quiz.problems.length);
    const answers = await app.waitForAnswerLines(solutions.length);

    assert.deepEqual(
      usage.map((line) => line.bail === true),
      quiz.problems.map((entry) => entry.expected.outcome === 'bail'),
      'a bail on the usage log is exactly a problem whose own route expects one',
    );
    assert.deepEqual(
      usage.map((line) => line.withTranscript === true),
      quiz.problems.map((entry) => entry.spoken.length > 0),
    );
    assert.deepEqual(
      answers.map((answer) => answer.title),
      solutions.map((entry) => entry.expected.title),
    );
    assert.equal(
      answers.length,
      quiz.problems.length - bails.length,
      'only the bail problems produce no answer line',
    );
    assert.deepEqual(
      await app.getAnswers(),
      answers,
      'and the client reads back the same history the disk holds',
    );

    const spokenLines = quiz.problems.flatMap((entry) => entry.spoken);
    const transcript = await app.waitForTranscriptLines(spokenLines.length);
    assert.deepEqual(
      transcript.map((line) => line.text),
      spokenLines.map((line) => line.text),
      'one transcript line per thing said across the whole quiz, in order',
    );

    // A bail on a problem's own route always names the newer, spoken-only
    // marker: that route never carries a screenshot, so the older
    // `# No exercise on screen` would be a false claim about a screen it
    // never saw. The older marker still gets exercised elsewhere in this
    // file (the screen-carrying guard case above) -- this loop is only about
    // what a problem's *own* route produces.
    for (const entry of bails) {
      assert.equal(entry.expected.title, NO_QUESTION_TITLE, `${entry.id}: a bail on its own route has no screen to report on`);
    }
    // And the guard direction holds too: no problem's own-route bail is ever
    // the screen marker, which would mean a voice problem's dedicated route
    // fell back to reporting on a screen it was never sent.
    assert.ok(bails.every((entry) => entry.expected.title !== BAIL_TITLE));
  });

  it('a voice-about-screen problem asked with recording off still solves, from the screen alone', async (t) => {
    // The state a real session lands in when the user forgets the toggle. The
    // app has nothing to send and says nothing about it -- the honest record
    // is an ordinary solve, which is what the logs must show.
    const app = await bootQuiz(t);
    const entry = problem(quiz, 'reverse-string-iteratively');
    assert.equal((await app.getRecording()).state, 'off');

    await app.setTarget(targetWindow(entry));
    await waitUntil(() => app.sessionsOpened.length === 1, 'the capture session is open');

    const response = await app.solveWithTranscript();
    assert.equal(response.status, 202, 'the button works whether or not anything was recorded');

    const call = await app.provider.waitForCall(1);
    assert.equal('transcript' in (call.options ?? {}), false, 'silence sends no block, not an empty one');
    call.answer(entry.expected.scriptedAnswer);

    const [answer] = await app.waitForAnswerLines(1);
    assert.equal(answer?.withTranscript, undefined, 'and it is logged as the ordinary solve it was');
  });
});
