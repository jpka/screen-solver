import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyFrameQuality } from '../../src/host/capture/frame-quality.ts';

/** Builds an RGBA buffer, one solid color repeated for every pixel. */
function solidFrame(width: number, height: number, [r, g, b, a]: [number, number, number, number]): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  }
  return pixels;
}

describe('classifyFrameQuality', () => {
  it('flags an all-black frame', () => {
    const pixels = solidFrame(10, 10, [0, 0, 0, 255]);
    assert.equal(classifyFrameQuality(pixels, 10, 10), 'black-or-empty');
  });

  it('passes a frame with real (non-black) content', () => {
    const pixels = solidFrame(10, 10, [200, 120, 60, 255]);
    assert.equal(classifyFrameQuality(pixels, 10, 10), 'ok');
  });

  it('flags a zero-size frame (no pixel bytes at all)', () => {
    assert.equal(classifyFrameQuality(new Uint8Array(0), 0, 0), 'black-or-empty');
  });

  it('flags a frame with zero width or height even if pixel bytes are present', () => {
    const pixels = solidFrame(10, 10, [255, 255, 255, 255]);
    assert.equal(classifyFrameQuality(pixels, 0, 10), 'black-or-empty');
    assert.equal(classifyFrameQuality(pixels, 10, 0), 'black-or-empty');
  });

  it('flags a frame with pixel bytes but declared dimensions of nothing captured', () => {
    // Represents what a stalled/empty getUserMedia grab hands back: dimensions
    // claimed by the caller with no actual pixel data behind them.
    assert.equal(classifyFrameQuality(new Uint8Array(0), 100, 100), 'black-or-empty');
  });

  it('treats near-black noise below the channel threshold as still black', () => {
    const pixels = solidFrame(10, 10, [8, 8, 8, 255]);
    assert.equal(classifyFrameQuality(pixels, 10, 10), 'black-or-empty');
  });

  it('is a ratio check, not an any-bright-pixel check: a few bright pixels in an otherwise black frame still fail', () => {
    const pixels = solidFrame(100, 100, [0, 0, 0, 255]);
    // Light up a single pixel -- 1 in 10,000, well under the default 1% floor.
    pixels[0] = 255;
    pixels[1] = 255;
    pixels[2] = 255;
    assert.equal(classifyFrameQuality(pixels, 100, 100), 'black-or-empty');
  });

  it('passes once enough of the frame clears the ratio floor', () => {
    const pixels = solidFrame(100, 100, [0, 0, 0, 255]);
    // Light up the first two full rows: 200 of 10,000 pixels = 2%, above the 1% floor.
    for (let i = 0; i < 100 * 2 * 4; i += 4) {
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
    }
    assert.equal(classifyFrameQuality(pixels, 100, 100), 'ok');
  });

  it('respects an injected ratio/threshold override', () => {
    const pixels = solidFrame(10, 10, [0, 0, 0, 255]);
    pixels[0] = 255;
    pixels[1] = 255;
    pixels[2] = 255;
    // 1 of 100 pixels = 1% -- fails the default floor, passes a lowered one.
    assert.equal(classifyFrameQuality(pixels, 10, 10, { minNonBlackRatio: 0.005 }), 'ok');
  });
});
