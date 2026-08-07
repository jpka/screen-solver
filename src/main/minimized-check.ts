import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IsTargetMinimized, TargetWindowIdentity } from '../host/capture/types.ts';

const execFileAsync = promisify(execFile);

/**
 * The real `IsTargetMinimized`, wired into `bootstrapHost` from
 * `src/main/index.ts`.
 *
 * Electron has no API that answers "is this specific foreign top-level
 * window minimized" — `desktopCapturer` only lists capturable sources, it
 * doesn't expose window state. Windows itself does, via `user32.dll`'s
 * `IsIconic`, which PowerShell can call directly through `Add-Type`'s
 * P/Invoke support against the target process's `MainWindowHandle` — the
 * same "shell out to PowerShell for OS state Electron doesn't expose" move
 * `window-enumeration.ts` already makes for process-to-window pairing (#28).
 *
 * The process name and title are passed through environment variables rather
 * than interpolated into the script text, so a title containing a quote or
 * other PowerShell-meaningful character can't break the script — the same
 * concern `window-enumeration.ts` doesn't have to deal with today because its
 * `Get-Process` call takes no per-window filter argument at all.
 *
 * If no process currently matches both process name and title, this resolves
 * to `false` rather than throwing: minimized-ness isn't a meaningful question
 * for a window that can't be found, and "vanished from enumeration" is
 * already its own distinct signal (`checkWindowPresence`) for a caller to
 * check first. Like the WGC capture mechanism and window enumeration itself,
 * this needs a real Windows desktop and stays manual/E2E-verified rather than
 * unit-tested — see the PR for what that manual check looks like.
 */
export const isTargetMinimizedReal: IsTargetMinimized = async (
  target: TargetWindowIdentity,
): Promise<boolean> => {
  const script = `
    Add-Type -Name NativeWindow -Namespace ScreenSolver -MemberDefinition '
      [DllImport("user32.dll")]
      public static extern bool IsIconic(IntPtr hWnd);
    ';
    $proc = Get-Process | Where-Object {
      $_.ProcessName -eq $env:SCREEN_SOLVER_TARGET_PROCESS -and
      $_.MainWindowTitle -eq $env:SCREEN_SOLVER_TARGET_TITLE
    } | Select-Object -First 1;
    if ($null -eq $proc) {
      Write-Output 'not-found';
    } elseif ([ScreenSolver.NativeWindow]::IsIconic($proc.MainWindowHandle)) {
      Write-Output 'minimized';
    } else {
      Write-Output 'normal';
    }
  `;

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: {
        ...process.env,
        SCREEN_SOLVER_TARGET_PROCESS: target.processName,
        SCREEN_SOLVER_TARGET_TITLE: target.title,
      },
    },
  );

  return stdout.trim() === 'minimized';
};
