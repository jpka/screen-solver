// PROTOTYPE — wipe me. Thin terminal shell over classifier.js. Step through
// the real captured frame pairs, tune region/metric/threshold, and watch
// which pairs the classifier gets right against the hand-labelled ground
// truth. Run: node tui.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { classify } = require('./classifier');

const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'results.json'), 'utf8'));
const REGIONS = ['whole', 'instructions', 'editor', 'rightPane'];

const state = {
  pairIndex: 0,
  config: { region: 'instructions', metric: 'hash', threshold: 8 },
};

function render() {
  console.clear();
  const r = results[state.pairIndex];
  const { value, verdict } = classify(r, state.config);
  const correct = verdict === r.truth ? '\x1b[32mCORRECT\x1b[0m' : '\x1b[31mWRONG\x1b[0m';

  console.log(`\x1b[1mChange-detection prototype — ticket 05\x1b[0m  (pair ${state.pairIndex + 1}/${results.length})\n`);
  console.log(`\x1b[1mPair:\x1b[0m   ${r.pair}`);
  console.log(`\x1b[2m${r.note}\x1b[0m`);
  console.log(`\x1b[1mGround truth:\x1b[0m ${r.truth === 'different' ? '\x1b[33mNEW PROBLEM\x1b[0m' : 'same problem'}\n`);

  console.log('\x1b[1mmeasured metrics\x1b[0m');
  console.log(pad('region', 14) + pad('pixel-diff %', 14) + pad('hash distance', 14));
  for (const region of REGIONS) {
    const m = r.regions[region];
    const active = region === state.config.region ? '\x1b[36m' : '';
    console.log(active + pad(region, 14) + pad(m.pixelDiffPercent + '%', 14) + pad(String(m.hashDistance), 14) + '\x1b[0m');
  }

  console.log(`\n\x1b[1mclassifier config:\x1b[0m region=\x1b[36m${state.config.region}\x1b[0m metric=\x1b[36m${state.config.metric}\x1b[0m threshold=\x1b[36m${state.config.threshold}\x1b[0m`);
  console.log(`\x1b[1mverdict:\x1b[0m ${verdict.toUpperCase()} (value=${value})  -> ${correct}\n`);

  const allCorrect = results.map((row) => classify(row, state.config).verdict === row.truth);
  console.log(`\x1b[2mall pairs at this config: ${allCorrect.filter(Boolean).length}/${results.length} correct\x1b[0m\n`);

  console.log('\x1b[2m[n/p] next/prev pair  [r] cycle region  [m] cycle metric  [+/-] threshold  [q] quit\x1b[2m');
}

function pad(s, n) { s = String(s); return s.length >= n ? s + ' '.repeat(n - s.length) : s; }

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stdin.on('keypress', (str, key) => {
  if (key.name === 'q' || (key.ctrl && key.name === 'c')) { console.clear(); process.exit(0); }
  if (key.name === 'n') state.pairIndex = Math.min(results.length - 1, state.pairIndex + 1);
  if (key.name === 'p') state.pairIndex = Math.max(0, state.pairIndex - 1);
  if (key.name === 'r') {
    const i = REGIONS.indexOf(state.config.region);
    state.config.region = REGIONS[(i + 1) % REGIONS.length];
  }
  if (key.name === 'm') state.config.metric = state.config.metric === 'hash' ? 'pixel' : 'hash';
  if (str === '+') state.config.threshold += state.config.metric === 'hash' ? 1 : 0.1;
  if (str === '-') state.config.threshold = Math.max(0, state.config.threshold - (state.config.metric === 'hash' ? 1 : 0.1));
  render();
});

render();
