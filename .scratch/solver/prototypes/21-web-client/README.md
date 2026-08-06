# Prototype — the web client (ticket #21)

PROTOTYPE — throwaway. Answers "what does the web client look like on a phone
and on a desktop browser?"

Three variants of the focus pane, switchable via `?variant=`, on a new
throwaway page (sub-shape B — no real web client route exists yet). Drives
against the real SSE vocabulary from [The stream contract (#18)](https://github.com/jpka/screen-solver/issues/18):
`start` / `delta{text}` / `done{usage}` / `error{kind}` / `sync{text}`.

- **A — Bottom sheet history**: full-screen answer pane; a bottom tab pulls
  up a native-feeling bottom sheet over the history list; connection state
  is a slim top bar. Interrupted/history entries are visited by tapping a
  row, with a "Back to live" pill to return.
- **B — Header stack**: a slim sticky header (titlebar's spiritual
  successor) with a connection dot, truncated current-title, and history /
  settings icons that each open a full-screen slide-in overlay. Code blocks
  carry a per-block `wrap: on/off` toggle chip instead of a fixed choice.
- **C — Continuous log**: no separate live/history split — one scrollable
  feed, newest first. The live entry is expanded and outlined; past entries
  are collapsed to a one-line header and expand on tap. Connection trouble
  is an inline banner in the feed itself, not chrome. Settings live behind a
  floating action button since there's no header to hang it on.

## Run it

No build step — a single static HTML file with inline JS.

```bash
start .scratch/solver/prototypes/21-web-client/index.html
```

(or just double-click `index.html`; add `?variant=B` or `?variant=C` to open
directly into a variant — the switcher also works after load)

## Using it

- A demo answer ("Valid Parentheses") streams in automatically ~1s after
  load, following the answer-first content contract: `#` title, fenced
  code, then two short paragraphs.
- Two entries are pre-seeded in history (one tagged `interrupted`) so the
  history surfaces aren't empty.
- Top-right **PROTOTYPE CONTROLS** panel:
  - **New answer (interrupt)** — starts a fresh demo answer, pushing
    whatever was live into history (marked `interrupted` if it was still
    streaming).
  - **Simulate error** — ends the live answer with an `error{kind}` state,
    partial text preserved.
  - **Simulate disconnect** / **Simulate reconnect** — flips the connection
    indicator through `disconnected` → `reconnecting` → `connected`.
  - **Simulate mid-stream join** — starts a new answer already ~55% through,
    with a brief "syncing…" tag, standing in for a client that opens
    mid-flight and receives a `sync{text}` event instead of `start`.
  - **Toggle phone / desktop width** — resizes the device frame between
    390px and desktop, since the real question is how the same markup
    holds up at both widths, not just phone-only.
  - **Reset** — reloads.
- Bottom-center bar switches variants — click the arrows or press `←`/`→`.

## What it settled

- **Phone layout / history placement.** All three are viable; they trade off
  differently. A (bottom sheet) reads the most "native app"-like on a phone
  but is an unfamiliar pattern for a desktop browser tab. B (header +
  overlay) is the most symmetric between phone and desktop and maps most
  directly onto #7's original "titlebar icons" language. C (continuous log)
  needs no separate history affordance at all, at the cost of the focus
  pane's original "one dominant answer" framing — recommend **B** as the
  default carried forward, with C's collapsed-entry pattern worth stealing
  for how the history list itself renders inside B's overlay.
- **Code at phone width.** Wrapping (not horizontal scroll) holds up fine
  down to 390px for the demo answers — none needed the per-block toggle to
  stay readable. The toggle (variant B) is worth keeping anyway as a cheap
  escape hatch for a pathological single long line, rather than picking one
  behavior and hard-coding it.
- **Connection state.** Four states collapse to two independent signals
  rendered by one indicator: socket state (`connected` / `reconnecting` /
  `disconnected`) when viewing live, replaced entirely by "viewing history —
  not live" when the pane is showing a past entry regardless of socket
  state. A history view does not also need to show the socket is fine
  underneath — that's noise.
- **Joining mid-stream.** A brief `syncing…` tag that fades once real deltas
  resume reads as intentional rather than broken — confirms #18's `sync`
  event doesn't need special-case rendering beyond a small transient label.
- **What replaces always-on-top.** Confirmed there's nothing to build: a
  one-line caption ("a second open tab or your phone *is* the
  always-on-top") is enough to close the question, exercised in variant A.
- **Streaming feel.** At the measured 255–305 token answer length (#11), the
  4-char-per-tick reveal used here never feels like it's fighting pane
  scroll — no auto-scroll-while-reading problem showed up worth designing
  around.

## Capture

Full variant set committed to the throwaway branch `prototype/21-web-client`
per [`/prototype`](../../../docs/agents/issue-tracker.md); this README's
"What it settled" section is the answer folded into
[The web client (#21)](https://github.com/jpka/screen-solver/issues/21)'s
resolution comment.
