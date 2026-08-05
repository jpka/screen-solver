# PROTOTYPE — wipe me

Throwaway artifact for [ticket 05, "What counts as 'changed'"](../../issues/05-change-detection.md)
on the [Screen Solver map](../../map.md). No git repo exists yet in this project, so this lives
here instead of a throwaway branch — same idea, this whole directory is disposable once the
decision is lifted into the real app.

## The question

Given two consecutive captures of the same browser window, what test decides "a new problem
appeared, call the LLM" vs "nothing meaningful happened, skip"? Needs an answer backed by real
measurements, not intuition, because getting the threshold wrong in either direction breaks the
app (either it re-solves an unchanged screen every tick, or it silently misses a new problem).

## Method

`capture.js` drives real, headless Chromium (Puppeteer) against **live public kata pages** —
not a mock — because LeetCode's Cloudflare check blocks headless browsers outright, but
Codewars' kata-training pages (problem pane + real Monaco editor, no login required) load fine
headless and are structurally the same shape ticket 05 cares about. It captures a 1280×800
window through a scripted sequence: idle, idle again (noise-floor control), scroll the
instructions pane, hover a sidebar icon, type into the editor twice, idle after typing settles,
then navigate to a genuinely different kata.

`metrics.js` is the pure logic: crop a PNG to a region, pixelmatch percent-diff, and a from-
scratch dHash (9×8 grayscale downsample, adjacent-pixel comparison, 64-bit Hamming distance).
Four regions: whole window, the instructions/problem pane, the editor pane only, and the
right-hand column (editor + tests).

`analyze.js` computes every consecutive-pair metric and writes `results.json`.

`tui.js` is the interactive shell (`npm run tui`) — step through the real pairs, switch region/
metric, tune the threshold live, and see which pairs the classifier gets right against a
hand-labelled ground truth (only the final pair, navigating to a new kata, is a real "should
trigger"; everything else is "should skip").

Run order: `npm run capture` (already done, frames are checked into `frames/`) → `npm run
analyze` → `npm run tui`.

## Findings

**Measured table** (pixelmatch % / dHash Hamming distance out of 64, per region):

| pair | truth | whole | instructions | editor | right |
|---|---|---|---|---|---|
| idle → idle (+700ms) | same | 0% / 0 | 0% / 0 | 0.01% / 0 | 0% / 0 |
| idle → idle (+700ms again) | same | 0% / 0 | 0% / 0 | 0% / 0 | 0% / 0 |
| idle → scrolled | same | 1.51% / 2 | 3.87% / 12 | 0.01% / 0 | 0% / 0 |
| scrolled → hover (sidebar flyout opened) | same | 3.37% / 16 | 6.91% / 17 | 0% / 0 | 0% / 0 |
| hover → typing (1st chunk) | same | 3.4% / 17 | 6.91% / 17 | 0.24% / 3 | 0.05% / 5 |
| typing → typing (2nd chunk) | same | 0.03% / 2 | 0% / 0 | 0.27% / 2 | 0.05% / 3 |
| typing → settled (+600ms) | same | 0% / 1 | 0% / 0 | 0.02% / 0 | 0% / 0 |
| settled → **new kata loaded** | **different** | 2.42% / 10 | 4.83% / 19 | 0.98% / 2 | 1.08% / 9 |

**1. The real noise floor here was zero, but don't trust that number.** Back-to-back idle
captures 700ms apart, with nothing happening, produced exactly 0% diff and 0 hash distance in
every region — no detectable cursor-blink or timer noise in this headless capture. That's a
property of *this* pipeline (headless Chromium may not animate a caret the way a live composited
window does), not a guarantee for the real app's WGC capture path. Whatever ships needs to
re-measure its own noise floor against its own capture pipeline rather than inherit this number.

**2. The biggest surprise: an incidental hover produced more apparent change than the real
event we want to detect.** Hovering a sidebar icon opened a full navigation flyout that dimmed
and covered most of the left column — 6.91% diff / hash distance 17 in the instructions region.
That's *larger* than the real new-problem navigation (4.83% / 19 is close on hash, but the point
values overlap enough that no single static threshold on one tick cleanly separates "incidental
UI noise" from "a new problem loaded"). A naive "diff exceeds X, call the LLM" rule would fire
on this hover and might miss or double-count around the real event.

**3. But the hover noise is transient — and that's the fix.** Comparing the frame *before* the
hover started directly to a frame *after* it fully closed (skipping over the spike) gives
**exactly 0.00% / hash 0** in the instructions region — the flyout left no trace once it closed.
Contrast: the scroll's effect, checked the same way, does *not* cancel out (comparing pre-scroll
to two frames later still shows the identical 3.87%/12 the scroll produced), and neither does the
real navigation. **Debounce beats a tighter noise-floor threshold**: sample twice a short delay
apart (the data suggests several hundred ms is enough — Codewars' own flyout resolved within
that window) and only treat a diff as real if it's still there on the second look, rather than
tuning a threshold to somehow ignore transient overlays by magnitude alone (impossible here,
since the transient was bigger than the real signal).

**4. Scrolling cannot be reliably distinguished from navigating to a new problem by pixel/hash
diff alone.** Both are real, sustained (non-reverting) changes to the instructions pane, and
their magnitudes overlap (scroll: 3.87%/12, new problem: 4.83%/19). This capture pipeline is
pixels-only (no DOM/URL access — WGC captures a window, not a page), so there's no cheap way to
ask "did the *identity* of the problem change" directly. Recommendation: don't try to solve this
with a threshold. Accept the residual risk of an occasional scroll-triggered false positive and
bound its cost with ticket 08's cooldown/min-interval-between-solves, rather than chasing a
perfect classifier here.

**5. The editor pane is a clean, if narrow, signal — but only for what it rules out.** Scrolling
the instructions pane and the hover flyout both left the editor region at *exactly* 0%/hash 0 —
untouched. Typing changed it by 0.24–0.27% (hash 2–3), and the real navigation changed it too
(0.98%, hash 2, because the starter-code snippet differs) — so editor-region movement doesn't by
itself distinguish "user is typing" from "a new problem loaded with different starter code."
It's useful as a *negative* signal (if only the editor moved, definitely not a new problem) but
not as the primary trigger gate.

**6. Cost of the check itself.** dHash is a fixed 9×8 downsample (72 averaged blocks) plus a
64-bit compare — effectively free, independent of window resolution. Full-frame pixelmatch scans
every pixel in the region and costs meaningfully more at whole-window scale. Recommendation: use
dHash on the instructions region as the cheap per-tick gate; only run the heavier pixelmatch pass
as a confirmation step once dHash crosses threshold (which should be rare after debounce filters
transients).

## Recommendation for the real app

- **Algorithm:** dHash (64-bit, 9×8 downsample) on the **instructions/problem pane region**
  (excluding the editor and any icon-rail/nav chrome) as the primary per-tick signal. Cheap
  enough to run every tick.
- **Debounce, not a tighter threshold, for transient noise:** on a hash-distance jump, wait
  ~500ms–1s and re-check before deciding it's real. Only escalate to the LLM call if the second
  check still shows the change relative to the last-solved baseline. This is what neutralizes
  hover flyouts, tooltips, and similar transient chrome — a magnitude-only threshold can't,
  since this data shows transient noise can outweigh the real signal.
- **Threshold, provisionally:** hash distance ≥ ~10 in the instructions region, after the debounce
  check confirms persistence. This is one real navigation sample and one real scroll sample —
  not enough to be a confident cutoff, just a starting point to tune once the real capture
  pipeline (not headless Chromium) is in place.
- **Scroll-vs-navigate stays an open, accepted risk**, bounded by ticket 08's cooldown rather
  than solved here.
- **The editor pane does not gate the trigger** — it's a "same problem, user is actively typing"
  signal worth surfacing to ticket 06 (interrupt vs. queue), not a change-detection input.
- **Compare against the last-solved baseline, not merely the previous tick** — the previous-tick
  comparison is what let the transient hover spike register as "change" in the first place;
  diffing against the last frame that was actually sent to the LLM is what makes the
  debounce/settle check meaningful.
