#!/usr/bin/env node
/**
 * Screen Solver — token measurement for ticket #11 (solve-call prompt design).
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT
 * ----------------------------------
 * #9 made one number load-bearing: whether the system prompt clears the model's
 * minimum cacheable prefix (1024 t on claude-sonnet-5, 512 t on claude-opus-5).
 * The authoritative way to answer that is Anthropic's /v1/messages/count_tokens
 * endpoint. This session had no API key (api.anthropic.com answered 401), so the
 * count here is BRACKETED, not measured:
 *
 *   - @anthropic-ai/tokenizer  — a real Anthropic BPE, but the Claude 1/2
 *     generation. Historically runs a little HIGH versus current models.
 *   - gpt-tokenizer (cl100k)   — OpenAI's BPE. Different vocabulary, similar era
 *     and corpus; a well-behaved independent second opinion.
 *   - chars / 3.6              — Anthropic's own rule of thumb for English prose.
 *
 * Both proxies are documented to run LOW for current Claude models, which is the
 * lucky direction here:
 *   - Anthropic's own guidance is that OpenAI-family tokenizers (cl100k) undercount
 *     Claude tokens by ~15-20% on ordinary English, more on code and markup.
 *   - claude-sonnet-5 ships a NEW tokenizer producing ~30% more tokens than
 *     claude-sonnet-4-6 for identical text.
 * So the true claude-sonnet-5 count is very likely ABOVE the top of this bracket,
 * not below the bottom. Every known bias pushes the same way.
 *
 * The decision this feeds is a threshold test (is the prompt over 1024 t?), so a
 * bracket whose LOW end already clears the threshold settles it. Re-run against
 * count_tokens the first time a key is available; the exact figure only ever moves
 * the cache-savings percentage, never the on/off decision, as long as the low
 * bracket stays above 1024.
 *
 * Run:  node measure.js
 */

const fs = require('node:fs');
const path = require('node:path');

const anthropic = require('@anthropic-ai/tokenizer');
const gpt = require('gpt-tokenizer');

const MIN_CACHEABLE = { 'claude-sonnet-5': 1024, 'claude-opus-5': 512 };
const PRICE = { 'claude-sonnet-5': { in: 3, out: 15 }, 'claude-opus-5': { in: 5, out: 25 } };

function bracket(text) {
  const a = anthropic.countTokens(text);
  const g = gpt.encode(text).length;
  const c = Math.round(text.length / 3.6);
  return { anthropic: a, cl100k: g, charRule: c, low: Math.min(a, g, c), high: Math.max(a, g, c), chars: text.length };
}

function show(label, b) {
  console.log(
    `  ${label.padEnd(34)} ${String(b.chars).padStart(5)} chars  ` +
    `anthropic ${String(b.anthropic).padStart(5)}t  cl100k ${String(b.cl100k).padStart(5)}t  ` +
    `chars/3.6 ${String(b.charRule).padStart(5)}t   -> bracket ${b.low}–${b.high} t`
  );
}

const here = __dirname;
const prompt = fs.readFileSync(path.join(here, 'system-prompt.md'), 'utf8');

console.log('\n=== 1. The system prompt ===\n');
const sys = bracket(prompt);
show('system-prompt.md', sys);

console.log('\n  Minimum cacheable prefix:');
for (const [model, min] of Object.entries(MIN_CACHEABLE)) {
  const verdict = sys.low >= min ? `CACHEABLE (low bracket clears by ${sys.low - min} t)`
    : sys.high >= min ? `AMBIGUOUS — bracket straddles ${min} t`
    : `below ${min} t, not cacheable`;
  console.log(`    ${model.padEnd(18)} ${String(min).padStart(5)} t   ${verdict}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. What caching this prompt is worth (claude-sonnet-5, 1h TTL) ===');
console.log('   write 2.0x, read 0.1x. Session = one write then N-1 reads.\n');
for (const n of [1, 2, 5, 20, 60]) {
  const t = sys.low; // conservative: price the smallest plausible prompt
  const base = (t * PRICE['claude-sonnet-5'].in) / 1e6;
  const uncached = n * base;
  const cached = base * 2.0 + (n - 1) * base * 0.1;
  const sign = cached <= uncached ? 'saves' : 'COSTS';
  console.log(
    `  ${String(n).padStart(3)}-solve session:  uncached $${uncached.toFixed(5)}  ` +
    `cached $${cached.toFixed(5)}   ${sign} $${Math.abs(uncached - cached).toFixed(5)}`
  );
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Measured answers (real model output on the #6 capture frames) ===\n');
const traceDir = path.join(here, 'traces');
const traces = fs.existsSync(traceDir) ? fs.readdirSync(traceDir).filter((f) => f.endsWith('.md')).sort() : [];
const visible = [];
for (const f of traces) {
  const b = bracket(fs.readFileSync(path.join(traceDir, f), 'utf8'));
  show(f, b);
  visible.push(b);
}
if (visible.length) {
  const mean = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  const meanLow = mean(visible.map((b) => b.low));
  const meanHigh = mean(visible.map((b) => b.high));
  const maxHigh = Math.max(...visible.map((b) => b.high));
  console.log(`\n  visible-answer output: mean ${meanLow}–${meanHigh} t, max ${maxHigh} t across ${visible.length} traces`);
  console.log('  NOTE: this is the VISIBLE answer only. Thinking tokens also bill at the');
  console.log('  output rate and could not be measured without API access.');
  console.log(`  Headroom under max_tokens: 8000 -> ${8000 - maxHigh} t left for thinking on the longest trace.`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Image tokens for the actual capture frames ===');
console.log('   Anthropic: image tokens ~= (w * h) / 750. #9 assumed a 2560x1440 capture\n');
for (const [label, w, h] of [
  ['#6 prototype frames (as captured)', 1280, 800],
  ['#9 assumption, downscaled to 1568', 1568, 882],
  ['1080p window, no downscale needed', 1920, 1080],
  ['1440p window, downscaled to 1568', 1568, 882],
]) {
  console.log(`  ${label.padEnd(36)} ${w}x${h}  ->  ${Math.round((w * h) / 750)} image tokens`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Per-solve cost with the measured prompt (claude-sonnet-5) ===\n');
for (const [label, imgT, outT, cached] of [
  ['#9 shipped-default estimate', 1844, 1200, false],
  ['measured prompt, 1280x800 frame', 1365, 1200, false],
  ['measured prompt, cached prefix', 1365, 1200, true],
  ['measured prompt, measured visible out', 1365, visible.length ? Math.max(...visible.map((b) => b.high)) : 1200, true],
]) {
  const p = PRICE['claude-sonnet-5'];
  const sysCost = cached ? (sys.low * p.in * 0.1) / 1e6 : (sys.low * p.in) / 1e6;
  const total = (imgT * p.in) / 1e6 + sysCost + (outT * p.out) / 1e6;
  console.log(`  ${label.padEnd(38)} img ${String(imgT).padStart(4)}t  out ${String(outT).padStart(4)}t  = $${total.toFixed(4)}`);
}
console.log('');
