import type { ProviderErrorKind, Usage } from '../provider/types.ts';

/**
 * The final outcome of one solve attempt -- fired once via
 * `SolveLoopDeps.onOutcome` (`loop.ts`) for every attempt that actually
 * reached the provider. A pre-flight guard failure (vanished/minimized
 * target, black/zero-size frame) is a true no-op and never reaches this bus
 * at all: no wire event, no outcome, no provider call (spec "Not-capturable /
 * bad-frame detection").
 *
 * Deliberately separate from the SSE wire vocabulary (`start`/`delta`/`done`/
 * `error`, see `broadcaster.ts`), which has no `interrupted` kind -- the
 * wire-level experience of an interruption is just "the old stream stops
 * advancing and a fresh `start` begins immediately" (#29's own framing).
 * `interrupted` exists only on this internal bus, for #31 to persist to
 * `answers.jsonl` (tagged `interrupted: true`) the way a `done` outcome gets
 * persisted there too.
 *
 * A small explicit union over a class, matching `ConfigChangeEvent`
 * (`config/types.ts`) and `SolveEvent` (`provider/types.ts`)'s own style.
 */
export type SolveOutcome =
  | {
      readonly type: 'done';
      /** The full accumulated answer text -- every `delta` concatenated in order. */
      readonly text: string;
      readonly usage: Usage;
      readonly stopReason: string | null;
    }
  | {
      readonly type: 'interrupted';
      /** Whatever had accumulated before a newer `POST /solve` superseded this attempt. */
      readonly text: string;
    }
  | {
      readonly type: 'error';
      readonly kind: ProviderErrorKind;
      readonly message: string;
      /** Usually empty, but not always -- the provider seam can fail after some text has already streamed (spec: "stream dies mid-answer"). */
      readonly text: string;
    };
