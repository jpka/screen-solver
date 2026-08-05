// PROTOTYPE — wipe me. Captures a real sequence of screenshots from a live,
// public Codewars kata page to measure what a frame-to-frame diff sees.
const puppeteer = require('puppeteer');
const fs = require('fs');

const OUT = __dirname + '/frames';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KATA_A = 'https://www.codewars.com/kata/554b4ac871d6813a03000035/train/javascript'; // Highest and Lowest
const KATA_B = 'https://www.codewars.com/kata/514b92a657cdc65150000006/train/javascript'; // Multiples of 3 or 5

let seq = 0;
async function shot(page, label) {
  seq += 1;
  const name = `${String(seq).padStart(2, '0')}_${label}.png`;
  await page.screenshot({ path: `${OUT}/${name}` });
  console.log('captured', name);
  return name;
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('loading kata A...');
  await page.goto(KATA_A, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2500); // let Monaco finish laying out

  await shot(page, 'idle_a');       // baseline
  await sleep(700);
  await shot(page, 'idle_b');       // same state, cursor-blink window
  await sleep(700);
  await shot(page, 'idle_c');       // same state again

  // Scroll the instructions pane (left column) — same problem, different viewport content.
  await page.mouse.move(300, 400);
  await page.mouse.wheel({ deltaY: 350 });
  await sleep(400);
  await shot(page, 'scrolled');

  // Hover a nav icon — tests hover-state noise without any real edit.
  await page.mouse.move(24, 190);
  await sleep(300);
  await shot(page, 'hover');
  await page.mouse.move(640, 400); // move away again

  // Click into the Monaco editor and type — partial, same-problem change.
  await page.mouse.click(900, 280);
  await sleep(200);
  await page.keyboard.type('  return numbers', { delay: 60 });
  await shot(page, 'typing1');

  await page.keyboard.type('.slice().sort((a,b)=>a-b);', { delay: 60 });
  await shot(page, 'typing2');

  // Idle again right after typing stops — settle-time check.
  await sleep(600);
  await shot(page, 'typing_settled');

  // Navigate to a different kata entirely — whole-window change.
  console.log('loading kata B...');
  await page.goto(KATA_B, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(2500);
  await shot(page, 'new_problem');

  await browser.close();
  console.log('done. frames in', OUT);
})();
