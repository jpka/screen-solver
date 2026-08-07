/**
 * Pulls the answer's `#` heading out of its raw text.
 *
 * The system prompt's own contract is "lead with a `#` heading naming the
 * exercise" (spec story 18), and a literal `# No exercise on screen` heading
 * is the entire v1 "is there a problem here" detector -- no separate
 * pre-call classification pass exists (spec "System prompt"). This module is
 * that detector's read side: parse the heading the model already wrote,
 * rather than re-deciding anything.
 */

/** The v1 bail marker, verbatim from the spec's own literal string. */
export const BAIL_TITLE = 'No exercise on screen';

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

/** Whether a parsed title is exactly the v1 bail marker. Only meaningful for a `done` outcome -- see `recorder.ts`. */
export function isBailTitle(title: string | null): boolean {
  return title === BAIL_TITLE;
}
