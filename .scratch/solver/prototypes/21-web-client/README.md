# Prototype — the web client (ticket #21)

PROTOTYPE — throwaway. Answers "what does the web client look like on a phone
and on a desktop browser?"

Six variants of the focus pane, switchable via `?variant=`, on a new
throwaway page (sub-shape B — no real web client route exists yet). Drives
against the real SSE vocabulary from [The stream contract (#18)](https://github.com/jpka/screen-solver/issues/18):
`start` / `delta{text}` / `done{usage}` / `error{kind}` / `sync{text}`.

The device frame changes shape with the variant — A/B/C render at 390×780
(portrait phone), D/E/F at 844×390 (landscape phone). The desktop-size
toggle widens whichever orientation is active.

### Portrait — A, B, C (**C chosen**)

- **A — Bottom sheet history**: full-screen answer pane; a bottom tab pulls
  up a native-feeling bottom sheet over the history list; connection state
  is a slim top bar. Interrupted/history entries are visited by tapping a
  row, with a "Back to live" pill to return.
- **B — Header stack**: a slim sticky header (titlebar's spiritual
  successor) with a connection dot, truncated current-title, and history /
  settings icons that each open a full-screen slide-in overlay. Code blocks
  carry a per-block `wrap: on/off` toggle chip instead of a fixed choice.
- **C — Continuous log** ← **chosen for portrait**: no separate live/history
  split — one scrollable feed, newest first. The live entry is expanded and
  outlined; past entries are collapsed to a one-line header and toggle open
  on tap. Connection trouble is an inline banner in the feed itself, not
  chrome. Settings live behind a floating action button since there's no
  header to hang it on.

### Landscape — D, E, F (open)

Landscape inverts the scarcity: height is the constraint (a phone in
landscape has ~390px, less browser chrome), width is abundant. A vertically
stacked answer — heading, then code, then prose — is exactly the wrong shape
for it, so these three disagree about what to do with the extra width.

- **D — Split rail**: a 220px left rail carries connection state and the
  answer list (live entry pinned at top, history below); the right pane
  holds the full stacked answer. The most conventional of the three, and the
  only one where history is visible at all times without a gesture.
- **E — Code | prose columns**: the *answer itself* splits — a thin 36px
  strip on top, then code in the left column and the explanation in the
  right, each scrolling independently. History and settings move to
  slide-in overlays. This is the only variant that treats landscape as a
  different content layout rather than a different navigation layout.
- **F — Horizontal filmstrip**: C's continuous log rotated 90°. Answers are
  full-height cards laid out left-to-right with scroll-snap, newest
  leftmost and outlined. Preserves C's "no live/history split" framing on
  the axis that actually has room.

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
  - **Toggle phone / desktop size** — widens the current orientation's
    frame to desktop dimensions, since the real question is how the same
    markup holds up at both sizes, not just phone-only.
  - **Reset** — reloads.
- Bottom-center bar switches variants — click the arrows or press `←`/`→`.

## What it settled

- **Portrait layout / history placement — decided: C (continuous log).**
  Picked by the user after viewing on a real phone. History needs no
  separate affordance at all; collapsed entries in the same feed carry it,
  which costs the focus pane's original "one dominant answer" framing but
  removes a whole navigation surface. A and B remain in the file as the
  rejected alternatives.
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

## Open — the landscape question

Not yet decided; D/E/F are built for the user to judge on a real device.
Observations from building them, for whatever they're worth:

- **E is the only one that removes scrolling entirely.** At 844×390 the
  full answer — code, explanation and usage line — fits with room to spare,
  because splitting code from prose halves the vertical extent. D and F both
  still scroll vertically at that height.
- **F pays a two-axis scrolling cost.** Vertical scroll *inside* a card plus
  horizontal scroll *between* cards, in the orientation with the least
  vertical room. It preserves C's framing most faithfully and is the most
  awkward to actually drive.
- **D is the safe one.** Nothing about it is surprising, and it's the only
  variant where history stays visible without a gesture — but it spends
  220px of width on a list that's mostly empty in a short session.
- **Orientation change is a live event, not a page load.** None of these
  handle rotating the phone mid-stream; the frame here is switched by
  variant, not by a real media query. Whether the client swaps layout on
  rotation, or picks one layout and holds it, is a real decision this
  prototype does *not* answer.

## Capture

Full variant set committed to the throwaway branch `prototype/21-web-client`
per [`/prototype`](../../../docs/agents/issue-tracker.md); this README's
"What it settled" section is the answer folded into
[The web client (#21)](https://github.com/jpka/screen-solver/issues/21)'s
resolution comment.
