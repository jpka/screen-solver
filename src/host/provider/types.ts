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
  /**
   * Recent speech to answer alongside the screenshot, already windowed and
   * rendered by the caller (`audio/window.ts`).
   *
   * Optional, and absent on an ordinary solve: the plain Solve button sends a
   * screenshot and nothing else, exactly as it always has. Only the separate
   * "Solve with transcript" action fills this in.
   *
   * It becomes a *second* user-content block after the image, so the cached
   * system prefix is untouched and prompt caching still hits. The seam takes
   * rendered text rather than structured segments on purpose — deciding how
   * much history is worth sending, and how to label who said what, is a policy
   * question that belongs to the window, not to the wire.
   */
  readonly transcript?: string;
}

/** The one thing the rest of the app calls to turn a screenshot, recent speech, or both into an answer. */
export interface Provider {
  /** The model actually in use, for the usage log. */
  readonly model: string;
  /**
   * `image` is `null` for a spoken-only solve: the user asked a question out
   * loud and there is no screen to read it off. The transcript is then the
   * whole question rather than a hint about it, which is a distinction the
   * system prompt makes and this seam only has to carry.
   *
   * A call with neither an image nor a transcript has nothing to answer;
   * callers are expected not to make one (`POST /solve/transcript-only`
   * refuses with `400 no_transcript` rather than spending a call to find out),
   * and an implementation may reject it however is cheapest.
   */
  solve(image: SolveImage | null, options?: SolveOptions): AsyncIterable<SolveEvent>;
}
