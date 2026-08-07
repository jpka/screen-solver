import type { EnumerateWindows } from '../config/types.ts';
import type { IsTargetMinimized, TargetStatus, TargetWindowIdentity, WindowPresence } from './types.ts';

/**
 * Whether the target can still be found in a fresh window enumeration.
 *
 * Reuses #28's `EnumerateWindows` directly rather than inventing a new
 * mechanism — matching on process name + title, the same pairing
 * `resolveTargetWindowOnStartup` (`src/host/config/store.ts`) already uses to
 * re-find a saved target on startup. Deliberately returns `vanished`, not a
 * boolean "closed": what a caller does about a vanished target (re-resolve,
 * fall back to a picker, treat as ambiguous) is #29's decision, not this
 * module's.
 */
export async function checkWindowPresence(
  target: TargetWindowIdentity,
  enumerateWindows: EnumerateWindows,
): Promise<WindowPresence> {
  const windows = await enumerateWindows();
  const stillThere = windows.some(
    (candidate) => candidate.processName === target.processName && candidate.title === target.title,
  );
  return stillThere ? 'present' : 'vanished';
}

/**
 * The pre-flight signals a caller (#29) needs before spending a model call on
 * a target: is it still there, and if so, is it minimized.
 *
 * `isTargetMinimized` is skipped entirely once the target has already
 * vanished — minimized-ness isn't a meaningful question for a window that
 * can't currently be found, and skipping avoids a wasted PowerShell
 * round-trip for a process/title pair that's already known not to resolve.
 */
export async function checkTargetStatus(
  target: TargetWindowIdentity,
  dependencies: { enumerateWindows: EnumerateWindows; isTargetMinimized: IsTargetMinimized },
): Promise<TargetStatus> {
  const presence = await checkWindowPresence(target, dependencies.enumerateWindows);
  if (presence === 'vanished') {
    return { presence, minimized: false };
  }

  const minimized = await dependencies.isTargetMinimized(target);
  return { presence, minimized };
}
