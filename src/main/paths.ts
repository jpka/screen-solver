import { fileURLToPath } from 'node:url';

/**
 * The repo root, resolved from this module's location at runtime.
 *
 * NOTE: this file only ever runs from `dist/main/`, which is why two levels up
 * lands on the repo root. It is Electron-side only — nothing under `src/host/`
 * imports it, and neither should tests.
 */
export const appRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Static assets served or loaded as-is; not compiled, not copied. */
export const staticRoot = fileURLToPath(new URL('../../static/', import.meta.url));

/** The page loaded into the hidden renderer. Capture mechanism lands here (#30). */
export const hiddenRendererPage = fileURLToPath(
  new URL('../../static/renderer/index.html', import.meta.url),
);

/**
 * The preload script for the hidden renderer (#30).
 *
 * Lives under `static/renderer/`, not compiled by `tsc`, even though it's
 * Electron/Node-facing code that every other file in `src/main` would
 * normally be: sandboxed preload scripts (`hidden-window.ts` sets
 * `sandbox: true`) run as plain script outside Node's ESM/CJS module
 * resolution, so a `tsc`-emitted `import` statement is invalid syntax there
 * regardless of this project's `"type": "module"` setup. See
 * `static/renderer/preload.js` for the detail.
 */
export const hiddenRendererPreload = fileURLToPath(
  new URL('../../static/renderer/preload.js', import.meta.url),
);
