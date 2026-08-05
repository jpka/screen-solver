# Screen Solver

Label: `wayfinder:map`

## Destination

An **implementation-ready spec** for a Windows desktop app that captures a chosen browser window on an interval, calls a vision LLM only when the screen has meaningfully changed, and streams the solution to a coding exercise into its own read-only window.

Done means: nothing left to decide before someone starts coding.

## Notes

**Domain.** Greenfield Windows 11 desktop app. Repo at `C:\Users\jpkan\Claude\Projects\solver` — empty, not a git repo. Node 24.13 / npm 11.6 available; no Python, .NET, or Rust toolchain installed.

**Tracker.** Local markdown (no tracker configured — this is the default). Map is this file; tickets are `issues/NN-<slug>.md`. Run `/setup-matt-pocock-skills` to switch to GitHub/GitLab.

**Posture.** Plan, don't do. Every ticket resolves a decision; the map is done when the way is clear. Do not build the app from inside this map.

**Skills to consult.** `/grilling` and `/domain-modeling` by default; `/research` for research tickets; `/prototype` for prototype tickets; `/codebase-design` when designing the provider seam.

**Settled constraints.** Pinned down while naming the destination — these fix the scope and are not up for re-litigation inside a ticket:

| Constraint | Answer |
|---|---|
| Destination | Implementation-ready spec (plan, don't build) |
| First target | Coding exercises / katas (LeetCode, Exercism, Advent of Code, HackerRank) |
| Trigger | Configured interval + change detection — the LLM fires only on a meaningful diff, never on an unchanged screen |
| Capture target | A named window the user picks from a list, captured by handle so it follows moves and resizes |
| Scope boundary | Strictly read-only — the app displays answers and never acts on the page |
| LLM provider | Anthropic API only for v1 ([decided, ticket 03](issues/03-vision-provider-comparison.md)), behind a seam designed to admit a second provider later |

## Decisions so far

<!-- one line per closed ticket: enough to judge relevance, then open the link for detail -->

- [Window capture on Windows 11](issues/01-window-capture-api.md) — Target Windows.Graphics.Capture; Electron's `desktopCapturer` is already WGC-backed and sidesteps `PrintWindow`'s black-frame problem on GPU-composited Chrome/Edge. Two open risks flagged for the stack ticket: unconfirmed border-suppression on an unpackaged app, and unguaranteed stale-vs-black behavior on minimized/other-desktop windows.
- [Vision provider comparison](issues/03-vision-provider-comparison.md) — Decided directly by the user, skipping the planned cross-provider research: Anthropic API only for v1. The seam (ticket 04) is still designed to admit a second provider later.
- [App shell and stack](issues/02-app-shell-stack.md) — Electron + TypeScript. Capture loop, change detection, and the streaming Anthropic call all live in the main process; the output window is a thin renderer driven by IPC events, never touching the network or capture API directly.
- [Provider seam design](issues/04-provider-seam.md) — A deep module: `createProvider(config) → Provider` with `solve(image, {signal}) → AsyncIterable<SolveEvent>`. System prompt is configured once at construction, not per-call. Streaming normalizes to `delta`/`done{usage}`/`error{kind}`; transient errors (rate limit, overloaded, network) retry internally, `auth`/`refusal` surface immediately. Budget enforcement, change detection, and image capture stay outside the seam.
- [What counts as "changed"](issues/05-change-detection.md) — dHash on the instructions-pane region as the cheap per-tick signal, gated by a debounce (sample twice, ~500ms-1s apart, escalate only if the change persists against the last-*solved* baseline) rather than a tuned magnitude threshold — [a real prototype](prototypes/05-change-detection/) against live kata captures found that an incidental hover flyout produced *more* apparent change than the real navigation event, but the flyout's effect fully cancelled once checked past it while real changes didn't. Scroll-vs-navigate ambiguity is left as an accepted risk bounded by ticket 08's cooldown, not solved here. Editor-pane changes are excluded from the trigger gate.
- [The output window](issues/06-output-window.md) — "Focus pane": one dominant streaming answer pane, history/settings behind titlebar icons, new problem interrupts-and-replaces (previous pushed to history, tagged `interrupted`). [Three variants prototyped](prototypes/06-output-window/); code wraps rather than horizontal-scrolls, window is always-on-top by default and remembers size/position across restarts.

## Not yet specified

<!-- in-scope fog: suspected questions not yet sharp enough to ticket -->

- **Failure behavior** — what the app does when the API is down, the target window closes mid-run, or capture returns a black frame. Waits on the architecture taking shape.
- **Answer history persistence** — whether past solutions survive a restart, and where they live.
- **Detecting "not capturable" state** — ticket 01 established that a minimized or other-virtual-desktop window most likely returns WGC's last composited frame rather than erroring, but that's not a documented guarantee. The app needs its own check (e.g. `IsIconic`) rather than trusting frame freshness — exact detection and UX still fog.
- **Detection as a separate pass** — whether "is there a question on this screen?" needs to be its own cheap call before the expensive solve, or whether one call does both.

## Out of scope

<!-- ruled beyond the destination; never graduates -->

- **Auto-typing answers into the browser** — read-only was chosen deliberately; input injection is a different category of tool.
- **Clipboard copy of the answer** — strictly-read-only was chosen over the read-only-plus-clipboard variant.
- **Quizzes, puzzles, crosswords, general Q&A** — katas are the first and only target; generalizing the detection problem is a separate effort.
- **macOS and Linux** — Windows only.
- **A local on-device model as the v1 provider** — the seam should not preclude one later, but v1 does not ship it.
- **Comparing or supporting non-Anthropic vision providers for v1** — decided directly ([ticket 03](issues/03-vision-provider-comparison.md)): Anthropic only, no comparison research. The seam stays generic enough to add one later, but nothing beyond Anthropic ships now.
