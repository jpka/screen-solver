/**
 * Resolves `true` once `work` settles, or `false` if `timeoutMs` elapses first.
 *
 * Extracted from `bootstrap.ts` (#31), where shutdown's drain has always needed
 * it, once #47 gave it a second caller: `capture/session-coordinator.ts` awaits
 * the recorder's flush before tearing a stream down, and that await needs the
 * same bound for the same reason shutdown's does -- the thing being waited on
 * is cooperative, and a wedged renderer must not be able to stall a target
 * change permanently.
 *
 * The timer is cleared on the happy path, so a caller that settles immediately
 * doesn't hold the event loop open for the rest of the timeout.
 *
 * `work` is caught rather than propagated: every caller's work already handles
 * its own failures, and a rejection arriving *after* a timeout has already
 * moved on would otherwise surface as an unhandled rejection with nobody left
 * to receive it.
 */
export function settlesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void work
      .catch(() => {})
      .then(() => {
        clearTimeout(timer);
        resolve(true);
      });
  });
}
