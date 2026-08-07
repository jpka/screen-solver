import { silentLogger, type Logger } from '../logger.ts';
import type { Usage } from '../provider/types.ts';
import type { SolveOutcomeEvent } from '../solve/types.ts';
import type { AnswerLog } from './answer-log.ts';
import { isBailTitle, parseAnswerTitle } from './title.ts';
import type { AnswerLogEntry, UsageLogEntry } from './types.ts';
import type { UsageLog } from './usage-log.ts';

/**
 * Stand-in for a real usage figure when none exists. `interrupted` and
 * `error` outcomes never receive a `done` event from the provider seam
 * (`SolveOutcome`, `solve/types.ts` -- neither variant carries a `usage`
 * field), so there is no real token count to record for either. All-zero
 * rather than omitted, so every `usage.jsonl`/`answers.jsonl` line has the
 * same shape. This is a real limitation of what the provider seam can report,
 * not a deliberate design choice -- see the #31 PR's Judgment calls.
 */
const UNKNOWN_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export interface SolveLogRecorder {
  /** Persists one attempted call's outcome -- always to `usage.jsonl`, and to `answers.jsonl` too when the dispatch table below says so. */
  record(event: SolveOutcomeEvent): Promise<void>;
  /**
   * Resolves once every `record()` call made so far -- including ones queued
   * behind it in the internal chain, e.g. a superseded attempt's `interrupted`
   * write that was still in flight -- has finished. For shutdown: called
   * after the caller has already awaited the last `record()` it knows about,
   * so this is the belt to that call's suspenders, not a substitute for it.
   */
  drain(): Promise<void>;
}

export interface SolveLogRecorderDeps {
  readonly answerLog: AnswerLog;
  readonly usageLog: UsageLog;
  readonly logger?: Logger;
  /** Injected for tests; production uses the real clock. */
  readonly now?: () => Date;
}

/**
 * Turns one {@link SolveOutcomeEvent} into the right JSONL writes, per the
 * spec's own dispatch table ("Answer log" / "Usage log" / acceptance
 * criteria):
 *
 * | outcome                              | `usage.jsonl` | `answers.jsonl`          |
 * |---------------------------------------|---------------|---------------------------|
 * | `done`, normal answer                 | yes           | yes                       |
 * | `done`, bail (`# No exercise on screen`) | yes        | no                        |
 * | `interrupted`                         | yes           | yes, `interrupted: true`  |
 * | `error`                               | yes           | no                        |
 *
 * A bail is detected exactly the way the model itself signals it: the
 * parsed title is the literal string `title.ts` calls `BAIL_TITLE` -- there
 * is no separate classifier, matching the spec's framing of the heading as
 * "the entire v1 'is there a problem here' detector". Bail detection only
 * ever applies to a `done` outcome (the spec's own definition: "a bail is a
 * `done` outcome whose title is exactly...") -- an `interrupted` outcome is
 * always recorded to `answers.jsonl`, even in the (degenerate, shouldn't
 * happen in practice) case its partial text happens to match the bail title.
 *
 * Each write is independently try/caught and logged rather than thrown, so a
 * failure persisting one log (e.g. a full disk) doesn't prevent the other
 * from being attempted, and never crashes the solve loop that awaits this.
 *
 * `record()` calls are serialized through an internal promise chain rather
 * than fired concurrently. `loop.ts` can genuinely call this twice
 * overlapping in wall-clock time -- interrupt-and-replace means an old
 * attempt's `interrupted` outcome and a new attempt's `done` outcome are two
 * independent async chains that can both be mid-flight at once. Without
 * serializing, two concurrent `fs.appendFile` calls race on which one's
 * write actually lands first (disk I/O completion order, not call order),
 * so the *older* outcome could end up on a *later* line than the newer one
 * -- a JSONL reader has no way to tell "recorded out of order" from "really
 * did happen in this order". Chaining onto the previous call's promise
 * guarantees write order matches call order, which matches the order
 * `loop.ts` actually observed its two outcomes in.
 */
export function createSolveLogRecorder(deps: SolveLogRecorderDeps): SolveLogRecorder {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  let chain: Promise<void> = Promise.resolve();

  return {
    record(event: SolveOutcomeEvent): Promise<void> {
      const next = chain.then(() => recordOne(event));
      // However this attempt's write turns out, the *next* queued call must
      // still run -- swallow here so one failure can't wedge the chain for
      // every subsequent outcome (the failure itself is still logged inside
      // `recordOne`, and still observable to this call's own caller via the
      // returned/awaited `next`).
      chain = next.catch(() => {});
      return next;
    },
    drain: () => chain,
  };

  async function recordOne(event: SolveOutcomeEvent): Promise<void> {
    const timestamp = now().toISOString();
    const { outcome, target, model } = event;
    const title = outcome.type !== 'error' ? parseAnswerTitle(outcome.text) : null;
    const usage = outcome.type === 'done' ? outcome.usage : UNKNOWN_USAGE;
    const bail = outcome.type === 'done' && isBailTitle(title);

    const usageEntry: UsageLogEntry = {
      timestamp,
      model,
      target,
      outcome: outcome.type,
      usage,
      ...(bail ? { bail: true as const } : {}),
      ...(outcome.type === 'error' ? { errorKind: outcome.kind } : {}),
    };
    try {
      await deps.usageLog.append(usageEntry);
    } catch (error) {
      logger.error(`solve logs: failed to append to usage.jsonl: ${describeError(error)}`);
    }

    if (outcome.type === 'error') return;
    if (bail) return;

    const answerEntry: AnswerLogEntry = {
      title,
      text: outcome.text,
      timestamp,
      model,
      usage,
      target,
      ...(outcome.type === 'interrupted' ? { interrupted: true as const } : {}),
    };
    try {
      await deps.answerLog.append(answerEntry);
    } catch (error) {
      logger.error(`solve logs: failed to append to answers.jsonl: ${describeError(error)}`);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
