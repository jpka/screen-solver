import type { FrameQuality } from './types.ts';

export interface FrameQualityOptions {
  /**
   * 0-255. A pixel counts as non-black once any of its R/G/B channels
   * exceeds this. Real captures aren't perfectly `#000000` even at their
   * darkest (compression artifacts, near-black UI chrome), so the cutoff
   * sits a little above zero rather than requiring an exact match.
   */
  readonly blackChannelThreshold?: number;
  /** Minimum fraction of non-black pixels required to call a frame `ok`. */
  readonly minNonBlackRatio?: number;
}

const DEFAULT_BLACK_CHANNEL_THRESHOLD = 16;
const DEFAULT_MIN_NON_BLACK_RATIO = 0.01;

/**
 * Classifies one freshly captured frame as `ok` or `black-or-empty`, from raw
 * RGBA pixel bytes (e.g. a canvas `ImageData.data` buffer handed up from the
 * renderer) — the non-black-pixel-ratio check the spec's "Not-capturable /
 * bad-frame detection" decision calls for, run over the actual captured
 * frame rather than inferred from window state alone.
 *
 * A zero-size frame (no width, no height, or no pixel bytes at all) is always
 * `black-or-empty` — there's nothing to spend a model call on either way.
 *
 * Pure and synchronous by design: this is the one piece of the capture
 * pipeline genuinely worth unit-testing with canned buffers, since the
 * pipeline that produces those buffers (`desktopCapturer` -> `getUserMedia`
 * -> canvas) needs a real composited desktop and stays manual-only.
 */
export function classifyFrameQuality(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: FrameQualityOptions = {},
): FrameQuality {
  const blackChannelThreshold = options.blackChannelThreshold ?? DEFAULT_BLACK_CHANNEL_THRESHOLD;
  const minNonBlackRatio = options.minNonBlackRatio ?? DEFAULT_MIN_NON_BLACK_RATIO;

  if (width <= 0 || height <= 0 || pixels.length === 0) {
    return 'black-or-empty';
  }

  const totalPixels = width * height;
  let nonBlack = 0;

  for (let i = 0; i + 2 < pixels.length; i += 4) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    if (r > blackChannelThreshold || g > blackChannelThreshold || b > blackChannelThreshold) {
      nonBlack += 1;
    }
  }

  return nonBlack / totalPixels >= minNonBlackRatio ? 'ok' : 'black-or-empty';
}
