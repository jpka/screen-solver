// PROTOTYPE — wipe me. Computes every consecutive-pair metric once and
// writes results.json for the TUI to read. Also prints a flat table.
const fs = require('fs');
const path = require('path');
const { REGIONS, readPNG, pixelDiffPercent, dHash, hamming } = require('./metrics');

const FRAMES_DIR = path.join(__dirname, 'frames');

// Ground truth: is this consecutive pair "same problem" (should SKIP the
// LLM) or "a new problem appeared" (should TRIGGER)? Set by hand, from
// knowing what capture.js actually did at each step.
const SEQUENCE = [
  { file: '01_idle_a.png', note: 'baseline' },
  { file: '02_idle_b.png', note: 'idle +700ms, no action', truth: 'same' },
  { file: '03_idle_c.png', note: 'idle +700ms again, no action', truth: 'same' },
  { file: '04_scrolled.png', note: 'scrolled instructions pane', truth: 'same' },
  { file: '05_hover.png', note: 'hovered a nav icon', truth: 'same' },
  { file: '06_typing1.png', note: 'typed first chunk in editor', truth: 'same' },
  { file: '07_typing2.png', note: 'typed more in editor', truth: 'same' },
  { file: '08_typing_settled.png', note: 'idle +600ms after typing stopped', truth: 'same' },
  { file: '09_new_problem.png', note: 'navigated to a different kata', truth: 'different' },
];

const pngs = SEQUENCE.map((s) => readPNG(path.join(FRAMES_DIR, s.file)));

const results = [];
for (let i = 1; i < SEQUENCE.length; i++) {
  const a = pngs[i - 1], b = pngs[i];
  const row = { pair: `${SEQUENCE[i - 1].file} -> ${SEQUENCE[i].file}`, note: SEQUENCE[i].note, truth: SEQUENCE[i].truth, regions: {} };
  for (const [name, rect] of Object.entries(REGIONS)) {
    const pd = pixelDiffPercent(a, b, rect, 0.1);
    const hA = dHash(a, rect), hB = dHash(b, rect);
    row.regions[name] = { pixelDiffPercent: +pd.percent.toFixed(2), hashDistance: hamming(hA, hB) };
  }
  results.push(row);
}

fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2));

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

const header = pad('pair', 38) + pad('truth', 10) + padL('whole%', 8) + padL('whole#', 7) +
  padL('instr%', 8) + padL('instr#', 7) + padL('edit%', 8) + padL('edit#', 7) +
  padL('right%', 8) + padL('right#', 7);
console.log('\n' + header);
for (const r of results) {
  const w = r.regions.whole, ins = r.regions.instructions, e = r.regions.editor, rp = r.regions.rightPane;
  console.log(
    pad(r.pair, 38) + pad(r.truth, 10) +
    padL(w.pixelDiffPercent, 8) + padL(w.hashDistance, 7) +
    padL(ins.pixelDiffPercent, 8) + padL(ins.hashDistance, 7) +
    padL(e.pixelDiffPercent, 8) + padL(e.hashDistance, 7) +
    padL(rp.pixelDiffPercent, 8) + padL(rp.hashDistance, 7)
  );
}
console.log('\n(%: pixelmatch diff percent within region, #: dHash Hamming distance out of 64)');
