/**
 * How long to wait before reopening a transcription socket that dropped.
 *
 * A pure decision over "how many times in a row has this failed, and did the
 * last connection actually work for a while" -- no timers, no socket, no
 * network, so the ladder is unit-testable on its own. Same split, and the same
 * reason, as `capture/crash-restart-policy.ts`.
 *
 * Deliberately unlike the provider's give-up-after-three-attempts
 * (`anthropic.ts`'s `DEFAULT_RETRY_DELAYS_MS`): a solve has a human watching a
 * button, so failing fast and surfacing an error is the kind thing to do. A
 * recording is a background subscription nobody is staring at, and the right
 * response to ten minutes of dead Wi-Fi is to still be there when it comes
 * back -- not to have quietly given up and require the user to notice and
 * re-toggle. So the ladder climbs and then *holds* rather than terminating.
 */

/**
 * Climbing, then flat at 30s forever. Fast enough at the bottom that an
 * ordinary blip is invisible; slow enough at the top that a genuinely offline
 * machine isn't opening a socket every second for an hour.
 */
export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [250, 1_000, 3_000, 10_000, 30_000];

/**
 * A socket that stayed open at least this long is treated as having actually
 * worked, so the next failure starts a fresh ladder at the bottom.
 *
 * Without this, a connection that flaps -- opens, dies after two seconds,
 * opens, dies -- would climb to the 30s rung and stay pinned there, because
 * nothing would ever tell the policy that the connection is succeeding in
 * between. Sixty seconds is long enough that a genuinely broken link can't
 * accumulate it by accident, and short enough that a normal working session
 * clears it once and never thinks about it again.
 */
export const DEFAULT_HEALTHY_CONNECTION_MS = 60_000;

export interface ReconnectPolicyOptions {
  readonly delaysMs?: readonly number[];
  readonly healthyConnectionMs?: number;
}

export interface ReconnectDecision {
  readonly delayMs: number;
  /** 1-indexed, for the `reconnecting` event and the log line. */
  readonly attempt: number;
}

export interface ReconnectPolicy {
  /**
   * Call once per unexpected disconnect.
   *
   * `openDurationMs` is how long the socket that just died had been open --
   * the signal that decides whether this continues the current failure streak
   * or starts a new one. A socket that never opened at all should pass `0`.
   */
  onDisconnect(openDurationMs: number): ReconnectDecision;
  /** Forget the streak entirely -- called when recording stops and starts again. */
  reset(): void;
}

export function createReconnectPolicy(options: ReconnectPolicyOptions = {}): ReconnectPolicy {
  const delaysMs = options.delaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const healthyConnectionMs = options.healthyConnectionMs ?? DEFAULT_HEALTHY_CONNECTION_MS;

  let attempt = 0;

  return {
    onDisconnect(openDurationMs) {
      if (openDurationMs >= healthyConnectionMs) {
        attempt = 0;
      }
      attempt += 1;

      // The last rung holds for every further attempt: `Math.min` rather than
      // running off the end of the array, which is what makes this "climb then
      // hold" instead of "climb then give up".
      const index = Math.min(attempt - 1, delaysMs.length - 1);
      return { delayMs: delaysMs[index] ?? 0, attempt };
    },

    reset() {
      attempt = 0;
    },
  };
}
