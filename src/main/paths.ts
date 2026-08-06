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
