import { readFile as readFileFs, writeFile as writeFileFs } from 'node:fs/promises';
import { join } from 'node:path';
import { StartupError } from '../errors.ts';
import {
  DEFAULT_SCREEN_RECORDING_SETTINGS,
  type ConfigChangeEvent,
  type EnumerateWindows,
  type ProviderSelection,
  type ScreenRecordingSettings,
  type ScreenRecordingSettingsChangeEvent,
  type ScreenSolverConfig,
  type TargetWindowIdentity,
  type WindowInfo,
} from './types.ts';

export const CONFIG_FILE_NAME = 'config.json';

const EMPTY_CONFIG: ScreenSolverConfig = Object.freeze({
  targetWindow: null,
  provider: null,
  screenRecording: DEFAULT_SCREEN_RECORDING_SETTINGS,
});

/** No enumerator was injected. Nothing ever resolves, which is the same as the documented "no target configured" fallback. */
const NO_WINDOWS: EnumerateWindows = () => Promise.resolve([]);

/**
 * The live config, plus the ways it can change.
 *
 * `get()` is always the in-memory truth: after {@link loadConfigStore}
 * resolves once at startup, nothing here ever re-reads `config.json` off
 * disk — a write updates the in-memory value directly, which is what makes it
 * take effect immediately with no restart (spec story 4).
 */
export interface ConfigStore {
  get(): ScreenSolverConfig;

  /** Lists the windows a caller could offer as target-window choices. */
  listWindows(): Promise<readonly WindowInfo[]>;

  /**
   * Sets (or clears, with `null`) the target window.
   *
   * Persists to `config.json` first; only once that succeeds does the
   * in-memory config update and the change broadcast to subscribers, so a
   * failed write never leaves the live config and the file disagreeing.
   */
  setTargetWindow(target: TargetWindowIdentity | null): Promise<void>;

  /**
   * Updates any subset of the recording settings (#47), persisting and
   * broadcasting them the same write-then-publish way {@link setTargetWindow}
   * does. A partial patch rather than a whole-object setter because the client
   * only ever moves one control at a time, and a whole-object setter would let
   * a stale client silently revert a limit it never displayed.
   */
  setScreenRecordingSettings(patch: Partial<ScreenRecordingSettings>): Promise<ScreenRecordingSettings>;

  /** Subscribes to target-window changes. Call the returned function to unsubscribe. */
  onChange(listener: (event: ConfigChangeEvent) => void): () => void;

  /** Subscribes to recording-settings changes -- a separate bus; see {@link ScreenRecordingSettingsChangeEvent}. */
  onScreenRecordingSettingsChange(listener: (event: ScreenRecordingSettingsChangeEvent) => void): () => void;
}

export interface LoadConfigStoreOptions {
  readonly stateRoot: string;
  /**
   * Used once, at load, to re-resolve any saved target window (spec story 7/8
   * and #28 acceptance criterion 6). Left unset, resolution always "fails",
   * which is safe for callers that don't care about config.
   */
  readonly enumerateWindows?: EnumerateWindows;
  /** Injected for tests; production reads real files. */
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeFile?: (path: string, contents: string) => Promise<void>;
}

/**
 * Load (or create) `config.json` under the state root, and hand back a live
 * store.
 *
 * On first run — no file present — this creates one holding
 * `{ targetWindow: null, provider: null }` (acceptance criterion 1). On a
 * later run, any saved target window is re-resolved against
 * `enumerateWindows` before the store is handed back: if a currently open
 * window still matches by process name + title, the saved target is kept as
 * the live target; if nothing matches, the live target falls back to `null`
 * ("no target configured") without touching what's on disk, so a window that
 * reappears later with the same identity resolves again on a future start
 * without the user having to re-pick it.
 *
 * @throws {StartupError} `config-invalid` if `config.json` exists but isn't
 * readable, isn't valid JSON, or isn't a JSON object.
 */
export async function loadConfigStore(options: LoadConfigStoreOptions): Promise<ConfigStore> {
  const configPath = join(options.stateRoot, CONFIG_FILE_NAME);
  const readFileImpl = options.readFile ?? ((path: string) => readFileFs(path, 'utf8'));
  const writeFileImpl =
    options.writeFile ?? ((path: string, contents: string) => writeFileFs(path, contents, 'utf8'));
  const enumerateWindows = options.enumerateWindows ?? NO_WINDOWS;

  const onDisk = await readOrInitialize(configPath, readFileImpl, writeFileImpl);
  let current: ScreenSolverConfig = {
    ...onDisk,
    targetWindow: await resolveTargetWindowOnStartup(onDisk.targetWindow, enumerateWindows),
  };

  const listeners = new Set<(event: ConfigChangeEvent) => void>();
  const recordingListeners = new Set<(event: ScreenRecordingSettingsChangeEvent) => void>();

  return Object.freeze({
    get: () => current,

    listWindows: () => enumerateWindows(),

    async setTargetWindow(target: TargetWindowIdentity | null): Promise<void> {
      const next: ScreenSolverConfig = { ...current, targetWindow: target };
      await writeFileImpl(configPath, JSON.stringify(next, null, 2));
      current = next;

      const event: ConfigChangeEvent = { type: 'config', target };
      for (const listener of listeners) listener(event);
    },

    async setScreenRecordingSettings(patch: Partial<ScreenRecordingSettings>): Promise<ScreenRecordingSettings> {
      // Same write-then-publish ordering as `setTargetWindow`, for the same
      // reason: a failed write must not leave the live settings and the file
      // disagreeing. Sanitized on the way in so a bad value can't be persisted
      // and then re-read as a startup-time surprise -- `parseConfig` below
      // applies the identical rules to whatever is already on disk.
      const settings = sanitizeScreenRecordingSettings({ ...current.screenRecording, ...patch });
      const next: ScreenSolverConfig = { ...current, screenRecording: settings };
      await writeFileImpl(configPath, JSON.stringify(next, null, 2));
      current = next;

      const event: ScreenRecordingSettingsChangeEvent = { type: 'screen-recording-settings', settings };
      for (const listener of recordingListeners) listener(event);
      return settings;
    },

    onChange(listener: (event: ConfigChangeEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    onScreenRecordingSettingsChange(
      listener: (event: ScreenRecordingSettingsChangeEvent) => void,
    ): () => void {
      recordingListeners.add(listener);
      return () => {
        recordingListeners.delete(listener);
      };
    },
  });
}

/**
 * Re-resolve a saved target window against a fresh enumeration.
 *
 * Exported standalone (not just reachable through {@link loadConfigStore}) so
 * the fallback behavior is directly testable: handles aren't stable across
 * restarts, which is exactly why the identity is process name + title rather
 * than a handle, and this is the "re-find it" step that identity choice pays
 * for. Documented fallback: if nothing in the current enumeration matches
 * both fields, this resolves to `null` rather than throwing — the app falls
 * through to "no target configured" (the picker), never a startup failure.
 *
 * The same fallback applies if `enumerateWindows` itself rejects (the real
 * implementation shells out to `Get-Process` and calls Electron's
 * `desktopCapturer` — either can fail for reasons that have nothing to do
 * with whether the saved window still exists, e.g. a locked-down execution
 * policy or no screen-capture permission yet granted). A target window is
 * never load-bearing for the rest of the host to come up, so a resolution
 * failure here must not turn into a fatal startup error; it degrades to "no
 * target configured", the same as a window that's simply gone.
 */
export async function resolveTargetWindowOnStartup(
  saved: TargetWindowIdentity | null,
  enumerateWindows: EnumerateWindows,
): Promise<TargetWindowIdentity | null> {
  if (saved === null) return null;

  let windows: readonly WindowInfo[];
  try {
    windows = await enumerateWindows();
  } catch {
    return null;
  }

  const stillOpen = windows.some(
    (candidate) => candidate.processName === saved.processName && candidate.title === saved.title,
  );
  return stillOpen ? saved : null;
}

async function readOrInitialize(
  configPath: string,
  readFileImpl: (path: string) => Promise<string>,
  writeFileImpl: (path: string, contents: string) => Promise<void>,
): Promise<ScreenSolverConfig> {
  let raw: string;
  try {
    raw = await readFileImpl(configPath);
  } catch (error) {
    if (!isNotFound(error)) {
      throw new StartupError(
        'config-invalid',
        `Could not read the config file at ${configPath}: ${describe(error)}`,
        { cause: error },
      );
    }
    await writeFileImpl(configPath, JSON.stringify(EMPTY_CONFIG, null, 2));
    return EMPTY_CONFIG;
  }

  return parseConfig(raw, configPath);
}

function parseConfig(raw: string, configPath: string): ScreenSolverConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StartupError('config-invalid', `${configPath} is not valid JSON: ${describe(error)}`, {
      cause: error,
    });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new StartupError('config-invalid', `${configPath} must contain a JSON object.`);
  }

  const candidate = parsed as Partial<Record<keyof ScreenSolverConfig, unknown>>;
  return {
    targetWindow: isTargetWindowIdentity(candidate.targetWindow) ? candidate.targetWindow : null,
    provider: isProviderSelection(candidate.provider) ? candidate.provider : null,
    screenRecording: readScreenRecordingSettings(candidate.screenRecording),
  };
}

/**
 * Reads the `recording` block field-by-field, defaulting anything missing or
 * malformed rather than throwing.
 *
 * Deliberately *not* the `config-invalid` startup refusal `parseConfig` uses
 * for a whole-file parse failure: this block didn't exist before #47, so every
 * `config.json` written by an earlier version is missing it entirely, and
 * upgrading the app must not turn into a refusal to start. Per-field
 * defaulting also matches how `targetWindow`/`provider` above already treat a
 * malformed value (fall back to `null`, don't throw).
 */
function readScreenRecordingSettings(value: unknown): ScreenRecordingSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_SCREEN_RECORDING_SETTINGS;
  const candidate = value as Partial<Record<keyof ScreenRecordingSettings, unknown>>;
  return sanitizeScreenRecordingSettings({
    enabled:
      typeof candidate.enabled === 'boolean' ? candidate.enabled : DEFAULT_SCREEN_RECORDING_SETTINGS.enabled,
    segmentSeconds: numberOr(candidate.segmentSeconds, DEFAULT_SCREEN_RECORDING_SETTINGS.segmentSeconds),
    retentionBytes: numberOr(candidate.retentionBytes, DEFAULT_SCREEN_RECORDING_SETTINGS.retentionBytes),
    retentionDays: numberOr(candidate.retentionDays, DEFAULT_SCREEN_RECORDING_SETTINGS.retentionDays),
  });
}

/** Smallest segment length worth rolling. Below this, rolling costs more than it buys. */
const MIN_SEGMENT_SECONDS = 5;

/**
 * Clamps the three limits into ranges the rest of the subsystem can rely on.
 *
 * `segment-policy.ts` and `retention.ts` are pure functions that trust their
 * arguments; a `segmentSeconds` of `0` would roll on every chunk and a negative
 * `retentionBytes` would prune every segment the instant it was written. Both
 * are far better caught here, once, than defended against at each use site.
 */
function sanitizeScreenRecordingSettings(settings: ScreenRecordingSettings): ScreenRecordingSettings {
  return {
    enabled: settings.enabled,
    segmentSeconds: Math.max(MIN_SEGMENT_SECONDS, Math.floor(settings.segmentSeconds)),
    retentionBytes: Math.max(0, Math.floor(settings.retentionBytes)),
    retentionDays: Math.max(0, Math.floor(settings.retentionDays)),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isTargetWindowIdentity(value: unknown): value is TargetWindowIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).processName === 'string' &&
    typeof (value as Record<string, unknown>).title === 'string'
  );
}

function isProviderSelection(value: unknown): value is ProviderSelection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).provider === 'string' &&
    typeof (value as Record<string, unknown>).model === 'string'
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
