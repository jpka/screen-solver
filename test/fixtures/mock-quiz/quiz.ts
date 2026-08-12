import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TargetWindowIdentity } from '../../../src/host/config/types.ts';
import { BAIL_TITLE, NO_QUESTION_TITLE } from '../../../src/host/logs/title.ts';

/**
 * The mock quiz: a fixed set of problems covering the three ways a question
 * can reach this app, and the one place both halves of the test rig read it
 * from.
 *
 * `quiz.json` next to this file is the data itself, deliberately in JSON
 * rather than in this module: the manual rig (`index.html` + `quiz-page.js`,
 * served by `scripts/mock-quiz.mjs`) is a browser page that cannot import
 * anything from `src/` or `test/` -- the same constraint `AGENTS.md` already
 * documents for `static/renderer/` -- so a `.ts` module holding the problems
 * would have to be duplicated into a second copy for the page to render. A
 * `fetch('./quiz.json')` there and a `readFile` here is one file, no build
 * step, and nothing to drift.
 *
 * This module is the typed, validated read side. {@link loadMockQuiz} throws
 * on a quiz that violates any of the invariants below rather than handing
 * back something a test would then assert confusing things about:
 *
 * - ids are unique, and every one of the three kinds is represented;
 * - a `screen` problem has an exercise on screen, says nothing out loud, and
 *   expects a solution -- there is only one button for it, so only one
 *   `expected`;
 * - a `voice-about-screen` problem has both an exercise on screen and speech,
 *   and expects a solution shaped by what was said -- also only one button;
 * - a `voice` problem says something out loud and shows no exercise. It now
 *   has *two* expectations, because it has two buttons: `expected` is what
 *   its own route (`/solve/transcript-only`) should produce -- a real
 *   solution to the spoken question, or, when the speech itself asks
 *   nothing, the newer bail (`NO_QUESTION_TITLE`) -- and
 *   `expectedIfScreenSent` is what pressing the screen-carrying button
 *   (`/solve/with-transcript`) must produce instead: always the older bail
 *   (`BAIL_TITLE`), because the screen it would send has no exercise on it
 *   and the screen stays authoritative whenever there is one;
 * - each expectation's `scriptedAnswer` leads with the heading its own
 *   `title` names, so the answer a fake provider streams in an automated run
 *   is the same answer a human grades a real model against in a manual one;
 * - both bail markers are exercised somewhere in the quiz, so a change that
 *   silently broke either one has a fixture entry to catch it.
 */

/** How this problem is put to the user -- the axis the whole fixture exists to cover. */
export type MockQuizProblemKind =
  /** Everything needed is on the screen. Nothing is said out loud. */
  | 'screen'
  /** The problem is spoken; the screen holds nothing solvable. */
  | 'voice'
  /** The problem is on the screen and the speech constrains or disambiguates it. */
  | 'voice-about-screen';

/** What the model is expected to do with the problem. */
export type MockQuizOutcome =
  /** A real answer: heading, one code block, prose. */
  | 'solution'
  /** `# No exercise on screen`, verbatim, with no code block (`src/host/logs/title.ts`'s `BAIL_TITLE`). */
  | 'bail';

/** One thing said out loud, at a moment measured from the start of the problem. */
export interface SpokenLine {
  /**
   * Seconds from the start of this problem, ascending. The manual page speaks
   * the lines in this order (it does not sit out the real gaps -- a rig that
   * paused for sixteen seconds mid-quiz would just be tedious); the automated
   * suite maps it onto the transcript offsets a transcription socket reports.
   */
  readonly atSeconds: number;
  readonly text: string;
}

/** A page with a real exercise on it: statement, editor, sample tests. */
export interface ExerciseScreen {
  readonly kind: 'exercise';
  readonly site: string;
  /**
   * What the browser window is called while this problem is up. The manual
   * page sets `document.title` to it, and the automated suite uses it as the
   * fake window's title, so "the window Screen Solver is watching" means the
   * same thing in both.
   */
  readonly windowTitle: string;
  readonly title: string;
  /** The fenced-code-block tag the answer should carry. */
  readonly language: string;
  /** What the site's own language selector shows, which is not always the tag. */
  readonly languageLabel: string;
  readonly statement: readonly string[];
  readonly examples: readonly string[];
  readonly constraints: readonly string[];
  /** The editor pane's contents -- the signature the answer has to match exactly. */
  readonly starterCode: string;
  readonly sampleTests: string;
}

/** A page with nothing solvable on it: a catalogue, a call, a dashboard. */
export interface NoExerciseScreen {
  readonly kind: 'no-exercise';
  readonly site: string;
  readonly windowTitle: string;
  readonly title: string;
  readonly description: string;
  /** Whatever the page lists instead of an exercise. */
  readonly items: readonly string[];
}

export type MockQuizScreen = ExerciseScreen | NoExerciseScreen;

export interface MockQuizExpectation {
  readonly outcome: MockQuizOutcome;
  /** The `#` heading the answer must lead with. */
  readonly title: string;
  /** Fragments a correct answer contains -- the signature, the constraint that was only spoken. Empty for a bail. */
  readonly mustMention: readonly string[];
  /** What a human grading a real run should look for, in prose. */
  readonly notes: string;
  /**
   * What the fake provider streams for this expectation in an automated run
   * -- and, written out in full, what a good real answer looks like for a
   * human comparing against a manual one. Lives on the expectation, not the
   * problem, because a `voice` problem has two of these (see
   * {@link MockQuizProblem.expectedIfScreenSent}) and each button gets its
   * own scripted answer to match its own outcome.
   */
  readonly scriptedAnswer: string;
}

export interface MockQuizProblem {
  readonly id: string;
  readonly kind: MockQuizProblemKind;
  /** What this problem is in the quiz to catch. */
  readonly why: string;
  readonly screen: MockQuizScreen;
  readonly spoken: readonly SpokenLine[];
  /** What pressing this problem's own route (`solveRoute(problem)`) should produce. */
  readonly expected: MockQuizExpectation;
  /**
   * What pressing the *other*, screen-carrying button produces instead --
   * present only for a `voice` problem, whose own route
   * (`/solve/transcript-only`) is not its only reachable route. A `screen` or
   * `voice-about-screen` problem has one button and therefore only one
   * expectation, so this is `undefined` for both.
   */
  readonly expectedIfScreenSent?: MockQuizExpectation;
}

export interface MockQuiz {
  readonly title: string;
  readonly description: string;
  readonly problems: readonly MockQuizProblem[];
}

/** The fixture directory -- also what `scripts/mock-quiz.mjs` serves. */
export const MOCK_QUIZ_DIR = fileURLToPath(new URL('./', import.meta.url));

export const MOCK_QUIZ_FILE = fileURLToPath(new URL('./quiz.json', import.meta.url));

/**
 * Every browser process the mock quiz pretends to run in. One entry: the quiz
 * is one page in one browser, however many sites it impersonates.
 */
export const MOCK_QUIZ_PROCESS_NAME = 'chrome.exe';

/** Reads and validates `quiz.json`. Throws on anything the invariants above rule out. */
export async function loadMockQuiz(): Promise<MockQuiz> {
  const raw = await readFile(MOCK_QUIZ_FILE, 'utf8');
  return validateQuiz(JSON.parse(raw) as unknown);
}

/** Every solve route the quiz can press -- the client's whole vocabulary of buttons. */
export type MockQuizRoute = '/solve' | '/solve/with-transcript' | '/solve/transcript-only';

/**
 * Which solve route this problem is pressed with.
 *
 * Derived rather than stored in `quiz.json`: it is a function of the kind,
 * and a stored copy could disagree with one. A `screen` problem goes through
 * the plain route precisely so a run proves speech never reaches the model on
 * it -- see the "Solve while recording" case in the e2e suite. A `voice`
 * problem goes through the spoken-only route, since the whole point of that
 * kind is a question with no screen behind it; `expectedIfScreenSent` is what
 * the *other* route (`/solve/with-transcript`) produces for one instead, see
 * {@link expectationFor}.
 */
export function solveRoute(problem: MockQuizProblem): MockQuizRoute {
  switch (problem.kind) {
    case 'screen':
      return '/solve';
    case 'voice':
      return '/solve/transcript-only';
    case 'voice-about-screen':
      return '/solve/with-transcript';
  }
}

/**
 * What pressing `route` should produce for `problem`.
 *
 * `problem.expected` for the problem's own route, `problem.expectedIfScreenSent`
 * for a `voice` problem pressed with the screen-carrying route instead --
 * the one other combination the fixture defines. Anything else throws,
 * since a test asking about a route the fixture never scripted an answer for
 * is a test with a bug in it, not a quiz with a missing case.
 */
export function expectationFor(problem: MockQuizProblem, route: MockQuizRoute): MockQuizExpectation {
  if (route === solveRoute(problem)) return problem.expected;
  if (problem.kind === 'voice' && route === '/solve/with-transcript' && problem.expectedIfScreenSent) {
    return problem.expectedIfScreenSent;
  }
  throw new Error(
    `No expectation for mock quiz problem "${problem.id}" (kind "${problem.kind}") pressed with ${route}.`,
  );
}

/** The window Screen Solver is watching while this problem is up. */
export function targetWindow(problem: MockQuizProblem): TargetWindowIdentity {
  return { processName: MOCK_QUIZ_PROCESS_NAME, title: problem.screen.windowTitle };
}

/** Every window the quiz can put on screen, in problem order -- what a fake enumerator reports. */
export function quizWindows(quiz: MockQuiz): TargetWindowIdentity[] {
  return quiz.problems.map(targetWindow);
}

export function problemsOfKind(quiz: MockQuiz, kind: MockQuizProblemKind): MockQuizProblem[] {
  return quiz.problems.filter((problem) => problem.kind === kind);
}

/** One problem by id, or a failure naming what is actually in the quiz. */
export function problem(quiz: MockQuiz, id: string): MockQuizProblem {
  const found = quiz.problems.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(
      `No mock quiz problem "${id}". The quiz holds: ${quiz.problems.map((p) => p.id).join(', ')}.`,
    );
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const KINDS: readonly MockQuizProblemKind[] = ['screen', 'voice', 'voice-about-screen'];

function validateQuiz(value: unknown): MockQuiz {
  const root = object(value, 'quiz.json');
  const problems = array(root.problems, 'problems').map((entry, index) =>
    validateProblem(entry, `problems[${index}]`),
  );

  const ids = new Set<string>();
  for (const entry of problems) {
    if (ids.has(entry.id)) throw new Error(`quiz.json: duplicate problem id "${entry.id}".`);
    ids.add(entry.id);
  }

  for (const kind of KINDS) {
    if (!problems.some((entry) => entry.kind === kind)) {
      throw new Error(
        `quiz.json: no "${kind}" problem. The quiz exists to cover all three kinds; a run that skips one proves less than it looks like it does.`,
      );
    }
  }

  // Both bail markers, not just one -- a quiz that only ever exercised
  // BAIL_TITLE (or only ever NO_QUESTION_TITLE) would still pass every
  // per-problem check above while quietly losing coverage of the other
  // marker, which is the whole reason `title.ts` grew a second one.
  const expectations = problems.flatMap((entry) =>
    entry.expectedIfScreenSent === undefined ? [entry.expected] : [entry.expected, entry.expectedIfScreenSent],
  );
  if (!expectations.some((entry) => entry.outcome === 'bail' && entry.title === BAIL_TITLE)) {
    throw new Error(`quiz.json: no expectation exercises "${BAIL_TITLE}" -- the screen-authoritative bail is untested.`);
  }
  if (!expectations.some((entry) => entry.outcome === 'bail' && entry.title === NO_QUESTION_TITLE)) {
    throw new Error(
      `quiz.json: no expectation exercises "${NO_QUESTION_TITLE}" -- the spoken-only bail is untested.`,
    );
  }

  return {
    title: string(root.title, 'title'),
    description: string(root.description, 'description'),
    problems,
  };
}

function validateProblem(value: unknown, path: string): MockQuizProblem {
  const raw = object(value, path);
  const id = string(raw.id, `${path}.id`);
  const kind = KINDS.find((candidate) => candidate === raw.kind);
  if (kind === undefined) {
    throw new Error(`${path}.kind must be one of ${KINDS.join(' | ')}, got ${JSON.stringify(raw.kind)}.`);
  }

  const screen = validateScreen(raw.screen, `${path}.screen`);
  const spoken = array(raw.spoken, `${path}.spoken`).map((entry, index) =>
    validateSpokenLine(entry, `${path}.spoken[${index}]`),
  );
  const expected = validateExpectation(raw.expected, `${path}.expected`);
  const expectedIfScreenSent =
    raw.expectedIfScreenSent === undefined
      ? undefined
      : validateExpectation(raw.expectedIfScreenSent, `${path}.expectedIfScreenSent`);

  for (let i = 1; i < spoken.length; i += 1) {
    const previous = spoken[i - 1];
    const current = spoken[i];
    if (previous !== undefined && current !== undefined && current.atSeconds < previous.atSeconds) {
      throw new Error(`${path}.spoken must be in ascending atSeconds order; line ${i} goes backwards.`);
    }
  }

  const requiredScreenKind = SCREEN_KIND_BY_PROBLEM_KIND[kind];
  if (requiredScreenKind !== screen.kind) {
    throw new Error(
      `${path}: a "${kind}" problem must show a "${requiredScreenKind}" screen, not "${screen.kind}".`,
    );
  }
  const mustSpeak = SPEAKS_BY_PROBLEM_KIND[kind];
  if (mustSpeak !== spoken.length > 0) {
    throw new Error(
      mustSpeak
        ? `${path}: a "${kind}" problem must say something out loud.`
        : `${path}: a "${kind}" problem must say nothing out loud -- it is the control for "speech never reaches a plain solve".`,
    );
  }

  if (kind === 'screen' || kind === 'voice-about-screen') {
    // Exactly one button, so exactly one expectation, and it always solves --
    // the exercise (screen-only or screen-plus-speech) is right there to
    // answer.
    if (expected.outcome !== 'solution') {
      throw new Error(
        `${path}.expected.outcome must be "solution" for a "${kind}" problem, not "${expected.outcome}" -- the exercise is right there on screen.`,
      );
    }
    if (expectedIfScreenSent !== undefined) {
      throw new Error(
        `${path}.expectedIfScreenSent is only meaningful for a "voice" problem, which is the only kind with a second button -- a "${kind}" problem must not define one.`,
      );
    }
  } else {
    // voice: two buttons, so two expectations. The screen-carrying one
    // (`/solve/with-transcript`) always sees the same no-exercise screen this
    // problem shows, so it must always bail with the older marker; the
    // problem's own route (`/solve/transcript-only`) has no screen to be
    // wrong about, so it may solve the spoken question for real, or, if the
    // speech itself asks nothing, bail with the newer marker -- but never the
    // older one, since a spoken-only request reporting "no exercise on
    // screen" would be describing a screen it was never shown.
    if (expectedIfScreenSent === undefined) {
      throw new Error(
        `${path}.expectedIfScreenSent is required for a "voice" problem: pressing the screen-carrying button must still bail with "${BAIL_TITLE}", since the screen it sends has no exercise on it and stays authoritative whenever there is one.`,
      );
    }
    if (expectedIfScreenSent.outcome !== 'bail' || expectedIfScreenSent.title !== BAIL_TITLE) {
      throw new Error(
        `${path}.expectedIfScreenSent must be a bail titled exactly "${BAIL_TITLE}" -- that is the only thing the screen-carrying button can honestly produce for a voice-only problem.`,
      );
    }
    if (expected.outcome === 'bail' && expected.title !== NO_QUESTION_TITLE) {
      throw new Error(
        `${path}.expected: a "voice" problem's own route has no screen to report on, so a bail on it must be titled exactly "${NO_QUESTION_TITLE}", not "${expected.title}" -- "${BAIL_TITLE}" would be a false statement about a request that carried no screenshot.`,
      );
    }
  }

  return { id, kind, why: string(raw.why, `${path}.why`), screen, spoken, expected, expectedIfScreenSent };
}

/** What screen kind each problem kind must show, so the taxonomy can't quietly rot. */
const SCREEN_KIND_BY_PROBLEM_KIND: Record<MockQuizProblemKind, MockQuizScreen['kind']> = {
  screen: 'exercise',
  voice: 'no-exercise',
  'voice-about-screen': 'exercise',
};

/** Whether each problem kind must say something out loud. */
const SPEAKS_BY_PROBLEM_KIND: Record<MockQuizProblemKind, boolean> = {
  screen: false,
  voice: true,
  'voice-about-screen': true,
};

function validateScreen(value: unknown, path: string): MockQuizScreen {
  const raw = object(value, path);
  const common = {
    site: string(raw.site, `${path}.site`),
    windowTitle: string(raw.windowTitle, `${path}.windowTitle`),
    title: string(raw.title, `${path}.title`),
  };

  if (raw.kind === 'exercise') {
    return {
      kind: 'exercise',
      ...common,
      language: string(raw.language, `${path}.language`),
      languageLabel: string(raw.languageLabel, `${path}.languageLabel`),
      statement: strings(raw.statement, `${path}.statement`),
      examples: strings(raw.examples, `${path}.examples`),
      constraints: strings(raw.constraints, `${path}.constraints`),
      starterCode: string(raw.starterCode, `${path}.starterCode`),
      sampleTests: string(raw.sampleTests, `${path}.sampleTests`),
    };
  }

  if (raw.kind === 'no-exercise') {
    return {
      kind: 'no-exercise',
      ...common,
      description: string(raw.description, `${path}.description`),
      items: strings(raw.items, `${path}.items`),
    };
  }

  throw new Error(`${path}.kind must be "exercise" or "no-exercise", got ${JSON.stringify(raw.kind)}.`);
}

function validateSpokenLine(value: unknown, path: string): SpokenLine {
  const raw = object(value, path);
  const atSeconds = raw.atSeconds;
  if (typeof atSeconds !== 'number' || !Number.isFinite(atSeconds) || atSeconds < 0) {
    throw new Error(`${path}.atSeconds must be a non-negative number, got ${JSON.stringify(atSeconds)}.`);
  }
  return { atSeconds, text: string(raw.text, `${path}.text`) };
}

function validateExpectation(value: unknown, path: string): MockQuizExpectation {
  const raw = object(value, path);
  if (raw.outcome !== 'solution' && raw.outcome !== 'bail') {
    throw new Error(`${path}.outcome must be "solution" or "bail", got ${JSON.stringify(raw.outcome)}.`);
  }
  const title = string(raw.title, `${path}.title`);
  const scriptedAnswer = string(raw.scriptedAnswer, `${path}.scriptedAnswer`);
  if (!scriptedAnswer.startsWith(`# ${title}`)) {
    throw new Error(
      `${path}.scriptedAnswer must lead with "# ${title}", so the scripted answer and the graded expectation are the same answer.`,
    );
  }
  return {
    outcome: raw.outcome,
    title,
    mustMention: strings(raw.mustMention, `${path}.mustMention`),
    notes: string(raw.notes, `${path}.notes`),
    scriptedAnswer,
  };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object, got ${JSON.stringify(value)}.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array, got ${JSON.stringify(value)}.`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function strings(value: unknown, path: string): string[] {
  return array(value, path).map((entry, index) => string(entry, `${path}[${index}]`));
}
