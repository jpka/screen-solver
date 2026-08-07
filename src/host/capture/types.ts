/**
 * The capture seam's public vocabulary.
 *
 * A live capture session is one long-lived thing per target window, opened
 * once and held open while idle — never re-grabbed per solve (spec "Capture
 * session lifecycle"). The hidden renderer does the actual mechanism
 * (`desktopCapturer` source -> `getUserMedia` -> canvas -> downscale ->
 * encode); everything in this file is the decision-layer shape that
 * mechanism is wrapped in, matching the provider seam's `SolveEvent` style —
 * small explicit unions and interfaces, not classes.
 */

import type { ConfigChangeEvent, TargetWindowIdentity } from '../config/types.ts';
import type { ImageMediaType } from '../provider/types.ts';

export type { ConfigChangeEvent, TargetWindowIdentity };

/**
 * A non-black-pixel-ratio verdict on one freshly captured frame.
 *
 * `black-or-empty` covers both a zero-size grab (no pixels at all — e.g. a
 * stream that hasn't produced a frame yet) and a frame that came back but is
 * effectively all black, which is exactly what a minimized or
 * off-virtual-desktop window's capture looks like even when the grab itself
 * "succeeded" with no error (spec "Not-capturable / bad-frame detection").
 */
export type FrameQuality = 'ok' | 'black-or-empty';

/** One encoded frame handed back by an open capture session, already downscaled with no crop. */
export interface CapturedFrame {
  readonly mediaType: ImageMediaType;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly quality: FrameQuality;
}

/**
 * One live session against a target window. Opened once by
 * {@link OpenCaptureSession}, held open while idle, closed on a target
 * change or app shutdown — never opened and closed per solve, which would
 * flicker the OS yellow capture-indicator border.
 */
export interface CaptureSession {
  /** Grabs the current frame from the already-open stream — never opens a fresh one. */
  captureFrame(): Promise<CapturedFrame>;
  close(): Promise<void>;
}

/**
 * Opens a live capture session for one target window.
 *
 * `src/main/capture-session.ts` supplies the real WGC-backed implementation
 * (a `desktopCapturer` source turned into a `getUserMedia` stream in the
 * hidden renderer); tests supply a fake that hands back canned sessions. Same
 * seam shape as `EnumerateWindows` in `src/host/config/types.ts`.
 */
export type OpenCaptureSession = (target: TargetWindowIdentity) => Promise<CaptureSession>;

/**
 * Whether a target window, confirmed still open, is minimized
 * (`IsIconic`-equivalent) — answerable without requiring a frame grab first,
 * so a caller can skip spending a call on a window that's known to be
 * minimized before ever touching the capture pipeline.
 *
 * `src/main/minimized-check.ts` supplies the real implementation (PowerShell
 * `Add-Type`/P/Invoke against `user32.dll`'s `IsIconic`); tests supply a fake.
 */
export type IsTargetMinimized = (target: TargetWindowIdentity) => Promise<boolean>;

/**
 * Whether the target window can still be found in a fresh window
 * enumeration.
 *
 * Deliberately its own signal, not collapsed into "confirmed closed":
 * `vanished` is genuinely ambiguous between "the window was closed" and "it
 * moved to another virtual desktop", per the spec's "Not-capturable /
 * bad-frame detection" decision. A caller deciding what to do about a
 * vanished target (re-resolve, fall back to a picker, etc.) is #29's job, not
 * this module's.
 */
export type WindowPresence = 'present' | 'vanished';

/** The pre-flight signals a caller needs before spending a model call on a target window. */
export interface TargetStatus {
  readonly presence: WindowPresence;
  /**
   * `false` when {@link presence} is `vanished` — minimized-ness isn't
   * meaningful for a window that can't currently be found, so this is a
   * neutral default rather than a real answer. Check `presence` first.
   */
  readonly minimized: boolean;
}
