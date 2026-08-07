/**
 * The provider seam's public vocabulary.
 *
 * Everything the rest of the app knows about "ask a model to solve this
 * screenshot" lives in this file. A second vision provider replaces
 * `src/host/provider/anthropic.ts` and leaves these types alone — that is the
 * whole point of the seam (spec story 39).
 */

/** What the capture layer can hand us. Anthropic accepts all four. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** One captured frame, already downscaled by the renderer. */
export interface SolveImage {
  readonly mediaType: ImageMediaType;
  readonly bytes: Uint8Array;
}

/**
 * How hard the model is asked to think.
 *
 * The spec fixes `medium` as the default because effort moves cost more than
 * image size does — thinking bills at the output rate.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Token counts for one attempted call.
 *
 * The cache fields are mandatory rather than prophylactic: prompt caching is on
 * from v1, so a cost estimate that ignores them is wrong on every call after
 * the first.
 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/**
 * The three ways a solve can fail, as far as any caller is concerned.
 *
 * `transient` is the catch-all: the seam has already retried anything worth
 * retrying by the time a caller sees one, so a `transient` event means "the
 * call did not survive", not "try again yourself".
 */
export type ProviderErrorKind = 'auth' | 'refusal' | 'transient';

/**
 * One step of a solve.
 *
 * Exactly one terminal event (`done` or `error`) is emitted, and it is always
 * the last — unless the caller aborts, in which case the iterable simply ends.
 */
export type SolveEvent =
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'done';
      readonly usage: Usage;
      /**
       * Passed through so truncation is *detectable* rather than assumed away:
       * `max_tokens` means the answer was guillotined, and a code block cut off
       * mid-function looks complete enough to paste.
       */
      readonly stopReason: string | null;
    }
  | { readonly type: 'error'; readonly kind: ProviderErrorKind; readonly message: string };

export interface SolveOptions {
  /** Aborting ends the iterable quietly — no terminal event, no throw. */
  readonly signal?: AbortSignal;
}

/** The one thing the rest of the app calls to turn a screenshot into an answer. */
export interface Provider {
  /** The model actually in use, for the usage log. */
  readonly model: string;
  solve(image: SolveImage, options?: SolveOptions): AsyncIterable<SolveEvent>;
}
