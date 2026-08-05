# What counts as "changed"

Parent: [Screen Solver](../map.md)
Type: prototype
Status: resolved
Blocked by: 01

## Question

Given two consecutive captures of the same browser window, what test decides "this is a new problem, call the LLM" versus "nothing meaningful happened, skip"?

This is the ticket that makes the interval trigger affordable. Get it wrong in one direction and the app re-solves an unchanged screen every tick; wrong in the other and it silently misses a new problem.

Build a cheap prototype against **real captures of a real kata page** and answer:

- **The algorithm.** Perceptual hash, pixel diff with a threshold, region-based diff, or something else. Which distinguishes signal from noise here?
- **The noise floor.** A kata page has a blinking cursor, a running timer, hover states, a scrolling editor pane, and antialiasing jitter. What does each contribute to the diff, and where does the threshold have to sit to ignore all of them?
- **Scrolling.** Scrolling the problem statement changes many pixels but is often the *same* problem. Does the app re-solve, or does it need to recognize a scroll specifically?
- **Partial vs whole change.** Navigating to a new problem changes everything; typing in the editor changes one pane. Should the diff be scoped to a region of the window rather than the whole thing?
- **Debounce.** After a change is detected, does the app fire immediately or wait for the screen to settle?
- **Cost of the check itself.** The diff runs every tick; it must be cheap enough that a short interval isn't a CPU problem.

Deliverable: a threshold and algorithm recommendation backed by measured numbers from the prototype, plus the prototype linked from this ticket.

## Answer

**Prototype:** [`prototypes/05-change-detection/`](../prototypes/05-change-detection/) — Puppeteer-driven, real (not mocked) captures of a live public Codewars kata-training page (LeetCode blocks headless browsers via Cloudflare; Codewars doesn't and has the same problem-pane + Monaco-editor shape). A pure `metrics.js` (region crop, pixelmatch %, from-scratch dHash) and `classifier.js`, driven by an interactive TUI (`npm run tui`) for stepping through the real captured frame pairs against a hand-labelled ground truth. Full measured table and reasoning in the prototype's [README](../prototypes/05-change-detection/README.md).

**Algorithm:** dHash (64-bit, 9×8 downsample) on the instructions/problem-pane region (excluding the editor pane and icon-rail chrome) as the cheap per-tick signal — independent of window resolution, meaningfully cheaper than full-frame pixelmatch. Reserve pixelmatch as a confirmation pass only, not the per-tick gate.

**The real finding, and the reason debounce matters more than threshold tuning:** an incidental sidebar hover opened a navigation flyout that produced *more* apparent change (6.91% diff, hash distance 17 in the instructions region) than the actual "new problem loaded" event this ticket cares about (4.83%, hash 19) — the ranges overlap, so no single-tick magnitude threshold cleanly separates real navigation from incidental UI noise. But the hover's effect was transient: diffing the frame *before* the hover against a frame *after* it fully closed gives exactly 0.00%/hash 0 — it left no trace. Scrolling and the real navigation, checked the same way, do *not* cancel out. **Debounce (sample twice, ~500ms–1s apart, only escalate if the second look still shows the change against the last-solved baseline) is what filters transient noise; a magnitude threshold alone cannot**, since this data shows transient noise can outweigh the real signal.

**Scroll vs. navigate stays an open, accepted risk.** Both are real, sustained, non-reverting changes to the instructions pane with overlapping magnitudes (scroll: 3.87%/hash 12; new problem: 4.83%/hash 19), and this pipeline is pixels-only (no DOM/URL access) so there's no cheap way to check problem *identity* directly. Recommendation: don't chase a perfect classifier here — bound the cost of an occasional scroll-triggered false positive with ticket 08's cooldown/min-interval-between-solves instead.

**Editor pane excluded from the trigger gate.** It stayed at exactly 0%/hash 0 during scroll and hover, but typing and real navigation are both indistinguishable there (0.24–0.98%, hash 2–3) — so it's a useful *negative* signal ("only the editor moved, definitely not a new problem") and a "user is actively working" signal worth surfacing to ticket 06, but not the primary gate.

**Provisional threshold:** hash distance ≥ ~10 in the instructions region, after the debounce check confirms persistence — based on one real navigation sample and one real scroll sample, not a statistically confident cutoff. Needs re-tuning once the real WGC capture pipeline (not headless Chromium) is in place — this prototype's zero noise floor on truly idle frames may not hold there.
