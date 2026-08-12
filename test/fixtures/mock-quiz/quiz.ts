import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TargetWindowIdentity } from '../../../src/host/config/types.ts';

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
 * - a `screen` problem has an exercise on screen and says nothing out loud;
 * - a `voice` problem says something out loud, shows no exercise, and expects
 *   the bail -- see `expected.outcome` for why that is the right answer;
 * - a `voice-about-screen` problem has both, and expects a real solution;
 * - each `scriptedAnswer` leads with the heading `expected.title` names, so
 *   the answer a fake provider streams in an automated run is the same answer
 *   a human grades a real model against in a manual one.
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
}

export interface MockQuizProblem {
  readonly id: string;
  readonly kind: MockQuizProblemKind;
  /** What this problem is in the quiz to catch. */
  readonly why: string;
  readonly screen: MockQuizScreen;
  readonly spoken: readonly SpokenLine[];
  readonly expected: MockQuizExpectation;
  /**
   * What the fake provider streams for this problem in an automated run --
   * and, written out in full, what a good real answer looks like for a human
   * comparing against a manual one.
   */
  readonly scriptedAnswer: string;
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

/**
 * Which solve route this problem is pressed with.
 *
 * Derived rather than stored in `quiz.json`: it is a function of the kind,
 * and a stored copy could disagree with one. A `screen` problem goes through
 * the plain route precisely so a run proves speech never reaches the model on
 * it -- see the "Solve while recording" case in the e2e suite.
 */
export function solveRoute(problem: MockQuizProblem): '/solve' | '/solve/with-transcript' {
  return problem.kind === 'screen' ? '/solve' : '/solve/with-transcript';
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
  const scriptedAnswer = string(raw.scriptedAnswer, `${path}.scriptedAnswer`);

  for (let i = 1; i < spoken.length; i += 1) {
    const previous = spoken[i - 1];
    const current = spoken[i];
    if (previous !== undefined && current !== undefined && current.atSeconds < previous.atSeconds) {
      throw new Error(`${path}.spoken must be in ascending atSeconds order; line ${i} goes backwards.`);
    }
  }

  const shape = KIND_SHAPES[kind];
  if (shape.screen !== screen.kind) {
    throw new Error(`${path}: a "${kind}" problem must show a "${shape.screen}" screen, not "${screen.kind}".`);
  }
  if (shape.speaks !== spoken.length > 0) {
    throw new Error(
      shape.speaks
        ? `${path}: a "${kind}" problem must say something out loud.`
        : `${path}: a "${kind}" problem must say nothing out loud -- it is the control for "speech never reaches a plain solve".`,
    );
  }
  if (shape.outcome !== expected.outcome) {
    throw new Error(`${path}: a "${kind}" problem must expect "${shape.outcome}", not "${expected.outcome}".`);
  }
  if (!scriptedAnswer.startsWith(`# ${expected.title}`)) {
    throw new Error(
      `${path}.scriptedAnswer must lead with "# ${expected.title}", so the scripted answer and the graded expectation are the same answer.`,
    );
  }

  return { id, kind, why: string(raw.why, `${path}.why`), screen, spoken, expected, scriptedAnswer };
}

/** What each kind's other fields have to be, so the taxonomy can't quietly rot. */
const KIND_SHAPES: Record<
  MockQuizProblemKind,
  { readonly screen: MockQuizScreen['kind']; readonly speaks: boolean; readonly outcome: MockQuizOutcome }
> = {
  screen: { screen: 'exercise', speaks: false, outcome: 'solution' },
  voice: { screen: 'no-exercise', speaks: true, outcome: 'bail' },
  'voice-about-screen': { screen: 'exercise', speaks: true, outcome: 'solution' },
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
  return {
    outcome: raw.outcome,
    title: string(raw.title, `${path}.title`),
    mustMention: strings(raw.mustMention, `${path}.mustMention`),
    notes: string(raw.notes, `${path}.notes`),
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
