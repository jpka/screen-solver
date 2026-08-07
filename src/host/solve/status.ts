import type { ProviderErrorKind } from '../provider/types.ts';
import type { SolveOutcome } from './types.ts';

/**
 * The standing status pill's escalation ladder (spec: "Status pill ladder:
 * silent → auto-recovering → sticky" -- story 38, ticket #32).
 *
 * `silent` is the default, nothing-to-report state. `auto-recovering` marks a
 * hiccup the app expects to shake off on its own -- a `transient`/`refusal`
 * error, whose seam-level retries (`provider/anthropic.ts`) are already
 * exhausted by the time a caller ever sees one, but which a *fresh* solve
 * attempt might still succeed at. `sticky` marks something that will keep
 * failing on every future click until it's fixed outside the app -- in v1
 * that's only an `auth` rejection, since the API key is read once at startup
 * (`api-key.ts`) and nothing in this process can un-revoke it; a fresh solve
 * attempt is not expected to magically start working. `sticky` is also the
 * only level `loop.ts` prints to the host's console for (#32 acceptance
 * criterion).
 */
export type StatusLevel = 'silent' | 'auto-recovering' | 'sticky';

/** The pill's current reading: a level, plus which error kind last drove it (`null` at `silent`). */
export interface StatusSnapshot {
  readonly level: StatusLevel;
  readonly kind: ProviderErrorKind | null;
}

const SILENT: StatusSnapshot = { level: 'silent', kind: null };

export interface StatusTracker {
  /** The snapshot as of the last {@link onOutcome} call. */
  current(): StatusSnapshot;
  /**
   * Folds one solve outcome into the ladder.
   *
   * Returns the new snapshot only when the level (or its kind) actually
   * changed -- `null` means "nothing to broadcast or log", so a caller
   * (`loop.ts`) doesn't have to compare snapshots itself just to avoid a
   * redundant SSE `status` frame or a duplicate console line for, say, two
   * `transient` errors in a row.
   */
  onOutcome(outcome: SolveOutcome): StatusSnapshot | null;
}

/**
 * A fresh tracker, always starting `silent` -- one per `SolveLoop` instance
 * (`loop.ts`), living exactly as long as the process does. There is no
 * persistence across restarts: a restart is itself a coarse "explicitly
 * resolved" (spec's own phrase, #32 acceptance criterion), consistent with
 * the API key being re-read from `process.env` fresh on every launch.
 */
export function createStatusTracker(): StatusTracker {
  let snapshot: StatusSnapshot = SILENT;

  return {
    current: () => snapshot,
    onOutcome(outcome) {
      const next = nextSnapshot(snapshot, outcome);
      if (next === null || sameSnapshot(next, snapshot)) return null;
      snapshot = next;
      return next;
    },
  };
}

/**
 * The escalation rules themselves, per the spec's failure taxonomy table:
 *
 * - `done` -- a normal answer *or* a bail, both `type: 'done'` (`title.ts`'s
 *   bail detection is a separate, later concern of `recorder.ts`; this
 *   tracker doesn't need to know the difference) -- resolves anything
 *   standing, including `sticky`. A successful call is direct proof whatever
 *   was wrong isn't anymore; absent any dedicated "resolve" action in a v1
 *   with no client yet, this is what "explicitly resolved" (#32 acceptance
 *   criterion) cashes out to.
 * - `interrupted` (superseded by a newer solve, `loop.ts`) says nothing about
 *   app health either way -- left alone entirely.
 * - `error{kind:'auth'}` always escalates straight to `sticky`, and does not
 *   get displaced by a later `auto-recovering`-tier error -- a transient
 *   hiccup on top of a known-broken key doesn't make the key less broken.
 * - `error{kind:'transient'|'refusal'}` escalates `silent` to
 *   `auto-recovering`, but must not *downgrade* an existing `sticky` (kept
 *   sticky) or re-announce an existing `auto-recovering` (returns `null`,
 *   same "nothing new to say" reasoning as the `sameSnapshot` check above).
 */
function nextSnapshot(current: StatusSnapshot, outcome: SolveOutcome): StatusSnapshot | null {
  switch (outcome.type) {
    case 'done':
      return current.level === 'silent' ? null : SILENT;
    case 'interrupted':
      return null;
    case 'error':
      if (outcome.kind === 'auth') return { level: 'sticky', kind: 'auth' };
      return current.level === 'silent' ? { level: 'auto-recovering', kind: outcome.kind } : null;
  }
}

function sameSnapshot(a: StatusSnapshot, b: StatusSnapshot): boolean {
  return a.level === b.level && a.kind === b.kind;
}
