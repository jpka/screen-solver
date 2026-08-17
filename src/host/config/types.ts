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
 * A file or folder of reference material the user sets up ahead of time --
 * site conventions, a style guide, a reminder of which patterns to prefer.
 * Read fresh on every solve (`context/preload-context.ts`), so editing the
 * file takes effect on the next answer with no restart, even though the path
 * itself is fixed at startup like {@link ProviderSelection} -- there is no
 * live setter for this field, only the value `config.json` was loaded with.
 */
export interface ScreenSolverConfig {
  readonly targetWindow: TargetWindowIdentity | null;
  readonly provider: ProviderSelection | null;
  readonly contextPath: string | null;
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
