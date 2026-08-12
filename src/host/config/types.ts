/**
 * The config surface's public vocabulary.
 *
 * `config.json` lives under the state root (#26) and holds everything the app
 * needs across a restart: which window to watch, and — reserved here, not yet
 * written to by this ticket — which provider/model to call. Every field is
 * live-reloadable; see {@link ConfigStore} in `store.ts` for the write path.
 */

/**
 * A window's identity, deliberately not a raw OS handle: handles aren't
 * stable across restarts, but a process name plus title can be re-matched
 * against a fresh enumeration every time the app starts (spec story 7).
 */
export interface TargetWindowIdentity {
  readonly processName: string;
  readonly title: string;
}

/**
 * What enumeration hands back for one open window — the same shape as
 * {@link TargetWindowIdentity}, since identity is exactly what a picker needs
 * to disambiguate windows and what a later `setTargetWindow` call takes.
 */
export type WindowInfo = TargetWindowIdentity;

/**
 * Reserved for the provider/model selection the spec assigns to `config.json`
 * (spec "Config shape"). #28 only builds the target-window half of the
 * surface, so this stays `null` until whichever ticket wires provider
 * selection into the running provider instance (#27) actually writes it.
 */
export interface ProviderSelection {
  readonly provider: string;
  readonly model: string;
}

/**
 * Continuous recording's persisted settings (#47).
 *
 * Persisted, unlike the capture-adjacent toggle on `feat/audio-transcript`
 * (which is deliberately off on every launch and never written down). The
 * difference is what each one is for: audio transcription is a thing the user
 * reaches for during one session, while this ticket's whole premise is
 * *automatic* recording — a recorder that forgot it was enabled every time the
 * app restarted would fail its own acceptance criterion. The safety property
 * that mattered there is preserved differently here: `enabled` defaults to
 * `false`, the OS capture border is lit for the entire time a session is open,
 * and the client shows a live REC state, so recording is never silent.
 *
 * The three limits are settings rather than constants because they're the ones
 * a user with a small disk or a long working day genuinely needs to move, and
 * because `retention.ts`/`segment-policy.ts` take them as plain arguments
 * anyway — reading them from config costs nothing over hard-coding them.
 */
export interface ScreenRecordingSettings {
  /** Whether recording follows the capture session automatically. */
  readonly enabled: boolean;
  /** Roll to a fresh segment after this many seconds of wall clock. */
  readonly segmentSeconds: number;
  /** Total bytes of retained segments to stay under; oldest are pruned first. */
  readonly retentionBytes: number;
  /** Delete segments older than this many days, regardless of the byte budget. */
  readonly retentionDays: number;
}

export const DEFAULT_SCREEN_RECORDING_SETTINGS: ScreenRecordingSettings = Object.freeze({
  enabled: false,
  segmentSeconds: 300,
  retentionBytes: 2 * 1024 * 1024 * 1024,
  retentionDays: 7,
});

export interface ScreenSolverConfig {
  readonly targetWindow: TargetWindowIdentity | null;
  readonly provider: ProviderSelection | null;
  readonly screenRecording: ScreenRecordingSettings;
}

/**
 * Lists the top-level windows a user could pick from.
 *
 * Electron supplies the real implementation (`src/main/window-enumeration.ts`
 * — `desktopCapturer` paired with a process listing, since a capturable
 * source alone doesn't carry a process name); tests supply a fixed fake list.
 * This is a type only — no implementation lives in `src/host` — matching how
 * `HostRuntime.acquireInstanceLock` keeps Electron out of `src/host/bootstrap.ts`.
 */
export type EnumerateWindows = () => Promise<readonly WindowInfo[]>;

/**
 * Emitted whenever the target window changes, whether a fresh pick or a
 * clear. Named after the spec's own shorthand for it (`config{target}`) and
 * kept in the provider seam's `SolveEvent` style: one small union, not a
 * class. #28 only has to put this on an internal bus — #29's SSE layer and
 * #33's client are the eventual consumers.
 */
export type ConfigChangeEvent = {
  readonly type: 'config';
  readonly target: TargetWindowIdentity | null;
};

/**
 * Emitted whenever {@link ScreenRecordingSettings} change (#47).
 *
 * Deliberately a *separate* subscription from {@link ConfigChangeEvent} rather
 * than a second variant of it. Every existing `onChange` subscriber —
 * `startCaptureSessionCoordinator`, `createHostRoutes`'s `config{target}` SSE
 * mirror — reacts to a target change by tearing a capture session down and
 * building a new one. Folding "the user toggled recording" into that same
 * union would mean each of those subscribers grew a `if (event.type === ...)`
 * guard whose only purpose is to ignore the new event, and one of them
 * forgetting the guard would silently reopen the capture session (and flicker
 * the OS capture border) every time a checkbox moved.
 */
export type ScreenRecordingSettingsChangeEvent = {
  readonly type: 'screen-recording-settings';
  readonly settings: ScreenRecordingSettings;
};
