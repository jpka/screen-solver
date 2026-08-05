// PROTOTYPE — wipe me. Pure logic: no I/O beyond reading a PNG buffer already
// handed to it. This is the part worth lifting into the real app if the
// numbers below pan out.
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch').default;
const fs = require('fs');

const REGIONS = {
  whole: { x: 0, y: 0, w: 1280, h: 800 },
  instructions: { x: 0, y: 95, w: 568, h: 705 }, // left problem/instructions pane
  editor: { x: 584, y: 245, w: 660, h: 150 },     // just the code lines, Solution box
  rightPane: { x: 568, y: 95, w: 712, h: 705 },   // editor + sample tests column
};

function readPNG(path) {
  return PNG.sync.read(fs.readFileSync(path));
}

function cropToRegion(png, rect) {
  const out = new PNG({ width: rect.w, height: rect.h });
  PNG.bitblt(png, out, rect.x, rect.y, rect.w, rect.h, 0, 0);
  return out;
}

// Percent of pixels pixelmatch calls "different" within a region, at a given
// per-pixel color-distance sensitivity (0..1, pixelmatch's own `threshold`).
function pixelDiffPercent(pngA, pngB, rect, sensitivity = 0.1) {
  const a = cropToRegion(pngA, rect);
  const b = cropToRegion(pngB, rect);
  const diffPixels = pixelmatch(a.data, b.data, null, rect.w, rect.h, { threshold: sensitivity });
  const total = rect.w * rect.h;
  return { diffPixels, total, percent: (100 * diffPixels) / total };
}

// dHash (difference hash): downsample to 9x8 grayscale, compare each pixel to
// its right neighbour -> 64 bits. Robust to small anti-aliasing jitter,
// sensitive to overall structural layout.
function dHash(png, rect) {
  const cropped = cropToRegion(png, rect);
  const W = 9, H = 8;
  const gray = new Float64Array(W * H);
  const bw = rect.w / W, bh = rect.h / H;
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      let sum = 0, count = 0;
      const x0 = Math.floor(gx * bw), x1 = Math.floor((gx + 1) * bw);
      const y0 = Math.floor(gy * bh), y1 = Math.floor((gy + 1) * bh);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (cropped.width * y + x) << 2;
          const r = cropped.data[idx], g = cropped.data[idx + 1], b = cropped.data[idx + 2];
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          count++;
        }
      }
      gray[gy * W + gx] = count ? sum / count : 0;
    }
  }
  let bits = '';
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W - 1; gx++) {
      bits += gray[gy * W + gx] > gray[gy * W + gx + 1] ? '1' : '0';
    }
  }
  return bits; // 64-char binary string
}

function hamming(hashA, hashB) {
  let d = 0;
  for (let i = 0; i < hashA.length; i++) if (hashA[i] !== hashB[i]) d++;
  return d;
}

module.exports = { REGIONS, readPNG, cropToRegion, pixelDiffPercent, dHash, hamming };
