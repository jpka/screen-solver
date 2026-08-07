/**
 * The escalating restart policy for the hidden renderer (spec: "renderer
 * crash → auto-restart, escalating on repeat" -- ticket #32's failure
 * taxonomy).
 *
 * A pure decision over "how many crashes have happened, how recently" -- no
 * Electron, no timers, no `BrowserWindow`, so the escalation ladder itself is
 * unit-testable even though actually detecting a crash and re-creating the
 * hidden window (`src/main/hidden-window.ts`'s `render-process-gone`) needs a
 * real renderer process and stays manual/E2E-verified -- the same limitation
 * `minimized-check.ts` and `window-enumeration.ts` already carry for their
 * own Windows-only mechanism, and the one #32's own acceptance criteria
 * explicitly sanctions a documented manual step for ("e.g. simulating a
 * renderer crash").
 *
 * Escalation resets once a crash is far enough in the past that it no longer
 * looks like part of the same crash loop -- a renderer that crashed once
 * yesterday and once just now is two unrelated one-off crashes, not a loop,
 * and shouldn't be one restart away from giving up.
 */
export interface CrashRestartPolicyOptions {
  /** Crashes within this long of each other count as the same loop. Default 60s. */
  readonly loopWindowMs?: number;
  /** Restarts attempted within one loop before giving up entirely. Default 3. */
  readonly maxRestarts?: number;
  /**
   * Backoff before the Nth restart (1-indexed) within a loop. Default
   * `[0, 1_000, 5_000]` -- restart immediately the first time (most crashes
   * are one-offs), then back off in case the renderer needs a moment to
   * actually be restartable. The last entry holds for any further restart
   * within {@link maxRestarts}.
   */
  readonly backoffMs?: readonly number[];
}

export type CrashDecision =
  | { readonly action: 'restart'; readonly delayMs: number; readonly attempt: number }
  | { readonly action: 'give-up'; readonly attempt: number };

export interface CrashRestartPolicy {
  /** Call once per observed crash (`render-process-gone`). Returns what to do next. */
  onCrash(now?: Date): CrashDecision;
  /** Resets the loop counter -- call once the renderer is confirmed healthy again, so a much-later crash starts a fresh loop rather than continuing an old one. */
  reset(): void;
}

const DEFAULT_LOOP_WINDOW_MS = 60_000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_BACKOFF_MS: readonly number[] = [0, 1_000, 5_000];

export function createCrashRestartPolicy(options: CrashRestartPolicyOptions = {}): CrashRestartPolicy {
  const loopWindowMs = options.loopWindowMs ?? DEFAULT_LOOP_WINDOW_MS;
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  let attempt = 0;
  let lastCrashAtMs: number | null = null;

  return {
    onCrash(now = new Date()) {
      const nowMs = now.getTime();
      if (lastCrashAtMs !== null && nowMs - lastCrashAtMs > loopWindowMs) {
        // Far enough from the last crash: a fresh loop, not a continuation.
        attempt = 0;
      }
      lastCrashAtMs = nowMs;
      attempt += 1;

      if (attempt > maxRestarts) {
        return { action: 'give-up', attempt };
      }
      const index = Math.min(attempt - 1, backoffMs.length - 1);
      const delayMs = backoffMs[index] ?? 0;
      return { action: 'restart', delayMs, attempt };
    },
    reset() {
      attempt = 0;
      lastCrashAtMs = null;
    },
  };
}
