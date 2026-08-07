import { desktopCapturer } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EnumerateWindows, TargetWindowIdentity, WindowInfo } from '../host/config/types.ts';

const execFileAsync = promisify(execFile);

/**
 * The real window enumerator, wired into `bootstrapHost` from `src/main/index.ts`.
 *
 * `desktopCapturer.getSources` is the only Electron API that lists top-level
 * windows the way the capture pipeline (#30) will actually see them, but each
 * source only carries a title (`.name`) and an opaque id — no process name.
 * Windows' own process list is queried separately, via PowerShell's
 * `Get-Process`, which exposes `MainWindowTitle` for any process with a
 * visible top-level window, and paired to each `desktopCapturer` source by
 * exact title match.
 *
 * Judgment call: title is the only thing both sources share, so two windows
 * of the same app with an identical title (two untitled Notepad windows) are
 * genuinely ambiguous from this data alone — this enumerator does not try to
 * disambiguate further. Titles with no process match (a source `desktopCapturer`
 * sees but the process query didn't, e.g. a window mid-close) are skipped
 * rather than reported with a guessed or empty process name, since the target
 * identity's whole point is being enough to re-find a window later.
 */
export const enumerateOpenWindows: EnumerateWindows = async () => {
  const [sources, processTitles] = await Promise.all([
    desktopCapturer.getSources({ types: ['window'] }),
    listProcessWindowTitles(),
  ]);

  const windows: WindowInfo[] = [];
  for (const source of sources) {
    const title = source.name.trim();
    if (title === '') continue;

    const processName = processTitles.get(title);
    if (processName === undefined) continue;

    windows.push({ processName, title });
  }
  return windows;
};

/**
 * Finds the `desktopCapturer` source id for one target window (#30's capture
 * session needs this; enumeration alone only ever hands back process
 * name + title, never the opaque source id `getUserMedia` requires).
 *
 * Reuses the exact same title-then-process pairing {@link enumerateOpenWindows}
 * uses, just narrowed to one identity instead of listing everything — so the
 * two stay consistent by construction rather than by two independently
 * maintained matching rules. Returns `null` if nothing currently matches both
 * fields (the window may have closed, moved desktops, or changed title since
 * it was last enumerated).
 */
export async function findCaptureSourceId(target: TargetWindowIdentity): Promise<string | null> {
  const [sources, processTitles] = await Promise.all([
    desktopCapturer.getSources({ types: ['window'] }),
    listProcessWindowTitles(),
  ]);

  for (const source of sources) {
    const title = source.name.trim();
    if (title !== target.title) continue;
    if (processTitles.get(title) !== target.processName) continue;
    return source.id;
  }
  return null;
}

interface ProcessWindowRow {
  readonly ProcessName: string;
  readonly MainWindowTitle: string;
}

/** Maps window title -> owning process name, via PowerShell's `Get-Process`. */
async function listProcessWindowTitles(): Promise<Map<string, string>> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-Process | Where-Object { $_.MainWindowTitle } | ' +
      'Select-Object ProcessName, MainWindowTitle | ConvertTo-Json -Compress',
  ]);

  const trimmed = stdout.trim();
  if (trimmed === '') return new Map();

  // ConvertTo-Json emits a bare object (not a one-element array) when exactly
  // one row matches, so both shapes have to be handled.
  const parsed: ProcessWindowRow | ProcessWindowRow[] = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  const byTitle = new Map<string, string>();
  for (const row of rows) {
    byTitle.set(row.MainWindowTitle, row.ProcessName);
  }
  return byTitle;
}
