/**
 * Pulls the answer's `#` heading out of its raw text.
 *
 * The system prompt's own contract is "lead with a `#` heading naming the
 * exercise" (spec story 18), and a literal `# No exercise on screen` heading
 * is the entire v1 "is there a problem here" detector -- no separate
 * pre-call classification pass exists (spec "System prompt"). This module is
 * that detector's read side: parse the heading the model already wrote,
 * rather than re-deciding anything.
 *
 * The spoken-only solve added a second marker on the same principle
 * (`# No question in the recent speech`), for the request shape that has no
 * screen to report on at all -- see {@link NO_QUESTION_TITLE}.
 */

/** The v1 bail marker, verbatim from the spec's own literal string. */
export const BAIL_TITLE = 'No exercise on screen';

/**
 * The spoken-only request's own bail marker.
 *
 * A second marker rather than reuse of {@link BAIL_TITLE}: a request that
 * carried no screenshot has no screen to report on, so "no exercise on screen"
 * would be a false statement about what the model was shown. The two are
 * otherwise the same idea -- a `done` outcome that answered nothing, worth a
 * `usage.jsonl` line and not worth an `answers.jsonl` one -- which is why
 * {@link isBailTitle} treats them as one family rather than the recorder
 * growing a second branch.
 */
export const NO_QUESTION_TITLE = 'No question in the recent speech';

/**
 * The first `#`-prefixed line in `text`, with the `#` and surrounding
 * whitespace stripped -- `null` if no heading is present (e.g. an
 * `interrupted` outcome cut off before the heading finished streaming, or
 * before any text streamed at all).
 */
export function parseAnswerTitle(text: string): string | null {
  const match = /^#[ \t]+(.+)$/m.exec(text);
  return match ? (match[1] as string).trim() : null;
}

/** Whether a parsed title is exactly one of the bail markers. Only meaningful for a `done` outcome -- see `recorder.ts`. */
export function isBailTitle(title: string | null): boolean {
  return title === BAIL_TITLE || title === NO_QUESTION_TITLE;
}
