#!/usr/bin/env node
/**
 * Screen Solver — cost model for ticket #9 (cost control).
 *
 * Throwaway. Turns the grounded Anthropic per-token and per-image numbers into
 * per-call / per-hour / per-day figures so the budget defaults in the ticket are
 * computed rather than asserted.
 *
 * Grounded inputs (Anthropic pricing + vision, as of 2026-08):
 *   claude-opus-5    $5 / $25  per MTok in/out   high-res vision tier
 *   claude-sonnet-5  $3 / $15  per MTok in/out   high-res vision tier
 *                    ($2 / $10 introductory through 2026-08-31)
 *   claude-haiku-4-5 $1 / $5   per MTok in/out   standard vision tier
 *
 * Image tokens ~= (width * height) / 750, capped by the model's vision tier:
 *   high-res tier   long edge 2576 px, ~4784 tokens max
 *   standard tier   long edge 1568 px, ~1600 tokens max
 *
 * Thinking tokens bill at the OUTPUT rate. On claude-opus-5 adaptive thinking is
 * ON by default; `effort` is the lever that moves thinking volume.
 *
 * Run:  node cost-model.js
 */

const MODELS = {
  'claude-opus-5':   { in: 5, out: 25, longEdgeCap: 2576, imageTokenCap: 4784 },
  'claude-sonnet-5': { in: 3, out: 15, longEdgeCap: 2576, imageTokenCap: 4784 },
  'claude-sonnet-5-intro': { in: 2, out: 10, longEdgeCap: 2576, imageTokenCap: 4784 },
  'claude-haiku-4-5': { in: 1, out: 5, longEdgeCap: 1568, imageTokenCap: 1600 },
};

/** Approximate Anthropic image-token count for a capture, after our own downscale. */
function imageTokens(width, height, model, downscaleLongEdge) {
  const m = MODELS[model];
  // Our own pre-send downscale (never upscale), then the API's own tier cap.
  const target = Math.min(downscaleLongEdge ?? Infinity, m.longEdgeCap);
  const longEdge = Math.max(width, height);
  const scale = longEdge > target ? target / longEdge : 1;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return { w, h, tokens: Math.min(Math.round((w * h) / 750), m.imageTokenCap) };
}

function callCost({ model, capture, downscale, systemTokens, outputTokens }) {
  const m = MODELS[model];
  const img = imageTokens(capture[0], capture[1], model, downscale);
  const inTok = img.tokens + systemTokens;
  const inCost = (inTok * m.in) / 1e6;
  const outCost = (outputTokens * m.out) / 1e6;
  return {
    img, inTok, outputTokens,
    inCost, outCost, total: inCost + outCost,
  };
}

const usd = (n) => '$' + n.toFixed(4);
const usd2 = (n) => '$' + n.toFixed(2);

function row(label, r) {
  console.log(
    `  ${label.padEnd(46)} ` +
    `img ${String(r.img.tokens).padStart(4)}t (${r.img.w}x${r.img.h})  ` +
    `in ${String(r.inTok).padStart(5)}t  out ${String(r.outputTokens).padStart(5)}t  ` +
    `= ${usd(r.total).padStart(9)}`
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. Per-solve cost, by configuration ===');
console.log('   (capture = the browser window; system prompt assumed ~600 tokens;');
console.log('    output = visible answer + thinking, which bills at the output rate)\n');

const SYSTEM = 600;

const scenarios = [
  // label, model, capture, downscale, output tokens
  ['opus-5   native 1440p, effort high',   'claude-opus-5',   [2560, 1440], null, 2500],
  ['opus-5   native 1080p, effort high',   'claude-opus-5',   [1920, 1080], null, 2500],
  ['opus-5   ds1568,       effort medium', 'claude-opus-5',   [2560, 1440], 1568, 1200],
  ['opus-5   ds1568,       WORST (cap)',   'claude-opus-5',   [2560, 1440], 1568, 8000],
  ['sonnet-5 native 1440p, effort high',   'claude-sonnet-5', [2560, 1440], null, 2500],
  ['sonnet-5 ds1568,       effort medium', 'claude-sonnet-5', [2560, 1440], 1568, 1200],
  ['sonnet-5 ds1568,       intro pricing', 'claude-sonnet-5-intro', [2560, 1440], 1568, 1200],
  ['sonnet-5 ds1024,       effort medium', 'claude-sonnet-5', [2560, 1440], 1024, 1200],
  ['sonnet-5 ds1568,       WORST (cap)',   'claude-sonnet-5', [2560, 1440], 1568, 8000],
  ['haiku-4.5 ds1568,      effort n/a',    'claude-haiku-4-5', [2560, 1440], 1568, 1200],
];

const results = {};
for (const [label, model, capture, downscale, outputTokens] of scenarios) {
  const r = callCost({ model, capture, downscale, systemTokens: SYSTEM, outputTokens });
  results[label.trim()] = r;
  row(label, r);
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. The image lever, in isolation (sonnet-5, 2560x1440 capture) ===\n');
for (const ds of [null, 2576, 1920, 1568, 1280, 1024]) {
  const r = callCost({ model: 'claude-sonnet-5', capture: [2560, 1440], downscale: ds, systemTokens: SYSTEM, outputTokens: 1200 });
  const pct = ((1 - r.total / results['sonnet-5 native 1440p, effort high'].total) * 100);
  console.log(
    `  downscale long edge ${String(ds ?? 'none').padStart(5)}  ->  ` +
    `image ${String(r.img.tokens).padStart(4)}t   call ${usd(r.total)}   ` +
    `(input portion ${usd(r.inCost)}, ${(100 * r.inCost / r.total).toFixed(0)}% of call)`
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. The thinking/effort lever (sonnet-5, ds1568) ===');
console.log('   thinking bills at the output rate, so effort moves cost more than image size\n');
for (const [effort, out] of [['low ~', 600], ['medium ~', 1200], ['high ~', 2500], ['xhigh ~', 4000], ['max_tokens cap', 8000]]) {
  const r = callCost({ model: 'claude-sonnet-5', capture: [2560, 1440], downscale: 1568, systemTokens: SYSTEM, outputTokens: out });
  console.log(`  ${String(effort).padEnd(16)} out ${String(out).padStart(5)}t  ->  call ${usd(r.total)}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Runaway exposure: what an unguarded misfiring detector costs ===\n');
const DEFAULT = results['sonnet-5 ds1568,       effort medium'.trim()];
const WORST = results['opus-5   ds1568,       WORST (cap)'.trim()];

for (const interval of [5, 10, 30, 60]) {
  const perHour = 3600 / interval;
  console.log(
    `  every ${String(interval).padStart(2)}s tick fires  = ${String(perHour).padStart(4)} solves/hr  ->  ` +
    `${usd2(perHour * DEFAULT.total).padStart(9)}/hr at defaults, ` +
    `${usd2(perHour * WORST.total).padStart(10)}/hr worst-config`
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Proposed limits, and which one binds first ===\n');
const COOLDOWN_S = 20;
const HOURLY_CALLS = 40;
const DAILY_USD = 5;
const BREAKER_N = 8, BREAKER_MIN = 5;

const cooldownCap = 3600 / COOLDOWN_S;
const breakerRate = BREAKER_N * (60 / BREAKER_MIN);

console.log(`  cooldown ${COOLDOWN_S}s          -> ceiling ${cooldownCap}/hr  = ${usd2(cooldownCap * DEFAULT.total)}/hr at defaults`);
console.log(`  runaway breaker ${BREAKER_N}/${BREAKER_MIN}min -> trips at an effective ${breakerRate}/hr rate (fires within ~${BREAKER_MIN} min of a misfire)`);
console.log(`  hourly ceiling ${HOURLY_CALLS}    -> ${usd2(HOURLY_CALLS * DEFAULT.total)}/hr at defaults, ${usd2(HOURLY_CALLS * WORST.total)}/hr worst-config`);
console.log(`  daily cap ${usd2(DAILY_USD)}        -> ${Math.floor(DAILY_USD / DEFAULT.total)} solves/day at defaults, ${Math.floor(DAILY_USD / WORST.total)} worst-config`);
console.log('\n  binding order (fastest to slowest): breaker -> cooldown -> hourly ceiling -> daily cap');

// ---------------------------------------------------------------------------
console.log('\n=== 6. Realistic sessions ===\n');
for (const [label, solvesPerHour, hours] of [
  ['casual kata session (4 problems/hr, 1h)', 4, 1],
  ['focused session      (10 problems/hr, 2h)', 10, 2],
  ['heavy speed-run      (20 problems/hr, 3h)', 20, 3],
]) {
  const n = solvesPerHour * hours;
  console.log(`  ${label.padEnd(42)} ${String(n).padStart(3)} solves  = ${usd2(n * DEFAULT.total).padStart(7)} at defaults (${(100 * n * DEFAULT.total / DAILY_USD).toFixed(0)}% of the $${DAILY_USD} daily cap)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. Prompt caching: is it worth enabling for the fixed system prompt? ===');
console.log('   only the system prefix is cacheable (the screenshot differs every call).');
console.log('   minimum cacheable prefix: 1024t on sonnet-5, 512t on opus-5.');
console.log('   write 1.25x (5m TTL) or 2x (1h TTL); read 0.1x.\n');
for (const sysTok of [600, 1024, 2000, 4000]) {
  const m = MODELS['claude-sonnet-5'];
  const base = (sysTok * m.in) / 1e6;
  const cacheable = sysTok >= 1024; // sonnet-5 minimum cacheable prefix
  const savingPerRead = base - base * 0.1;
  // Break-even reads N: writeMult*base + N*0.1*base <= (N+1)*base
  const be = (mult) => (mult - 1) / 0.9;
  console.log(
    `  system prompt ${String(sysTok).padStart(4)}t  ` +
    `${cacheable ? 'cacheable  ' : 'BELOW MIN  '}` +
    `uncached/call ${usd(base)}  saving/read ${usd(savingPerRead)} ` +
    `(${(100 * savingPerRead / DEFAULT.total).toFixed(1)}% of a call)  ` +
    `break-even: ${be(1.25).toFixed(1)} reads in 5min / ${be(2.0).toFixed(1)} reads in 1h`
  );
}
console.log('\n   Session view — 1h TTL, one write then N reads, vs no caching at all:');
for (const sysTok of [1024, 2000, 4000]) {
  const m = MODELS['claude-sonnet-5'];
  const base = (sysTok * m.in) / 1e6;
  for (const n of [20]) {
    const cached = base * 2.0 + n * base * 0.1;
    const uncached = (n + 1) * base;
    // Session spend with a system prompt of this size, uncached.
    const callWithThisPrompt = callCost({
      model: 'claude-sonnet-5', capture: [2560, 1440], downscale: 1568,
      systemTokens: sysTok, outputTokens: 1200,
    }).total;
    const sessionSpend = n * callWithThisPrompt;
    console.log(
      `     ${String(sysTok).padStart(4)}t prompt, ${n}-solve session:  ` +
      `cached ${usd(cached)}  vs  uncached ${usd(uncached)}  ` +
      `-> saves ${usd(uncached - cached)} (${(100 * (uncached - cached) / sessionSpend).toFixed(1)}% of the ${usd2(sessionSpend)} session)`
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. Would a cheap "is there a question here?" detector pass pay for itself? ===');
console.log('   (the map lists this as open fog; here is the arithmetic)\n');
const SOLVE = DEFAULT.total;
for (const [detLabel, detCost] of [
  ['haiku-4.5 ds1568 detector', results['haiku-4.5 ds1568,      effort n/a'.trim()].total],
  ['haiku-4.5 ds1024 detector', callCost({ model: 'claude-haiku-4-5', capture: [2560, 1440], downscale: 1024, systemTokens: 200, outputTokens: 20 }).total],
]) {
  // Adding a detector to every trigger costs detCost always, and saves SOLVE on
  // the fraction p that it suppresses. Worth it when detCost < p * SOLVE.
  const breakeven = detCost / SOLVE;
  console.log(
    `  ${detLabel.padEnd(28)} ${usd(detCost)}/check  vs  solve ${usd(SOLVE)}  ->  ` +
    `pays off only if it suppresses > ${(100 * breakeven).toFixed(0)}% of would-be solves`
  );
}
console.log('');
