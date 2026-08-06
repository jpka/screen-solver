# Prototype — the web client (ticket #21)

PROTOTYPE — throwaway. Answers "what does the web client look like on a phone
and on a desktop browser?"

Drives against the real SSE vocabulary from [The stream contract (#18)](https://github.com/jpka/screen-solver/issues/18):
`start` / `delta{text}` / `done{usage}` / `error{kind}` / `sync{text}`.

**The default mode is `auto` — this is the decided answer, not a variant.**
It fills the real viewport, detects orientation with a real media query, and
swaps layout live on rotation with no reload:

| orientation | layout |
|---|---|
| portrait | **C — continuous log** |
| landscape | **D — split rail** |

`?variant=A`…`F` still forces a single layout inside a simulated device
frame, kept so the rejected alternatives stay comparable. Those are history;
`auto` is the thing to judge.

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

### Landscape — D, E, F (**D chosen**)

Landscape inverts the scarcity: height is the constraint (a phone in
landscape has ~390px, less browser chrome), width is abundant. A vertically
stacked answer — heading, then code, then prose — is exactly the wrong shape
for it, so these three disagree about what to do with the extra width.

- **D — Split rail** ← **chosen for landscape**: a narrow left rail carries
  connection state, the answer list (live entry pinned at top, history
  below), and a footer with fullscreen + settings; the right pane holds the
  full stacked answer. The only variant where history is visible at all
  times without a gesture. Rail narrowed from 220px to **132px** after
  review — at 844px wide, 220px spent a quarter of the viewport on a list
  that is mostly empty in a short session. Titles clamp to two lines.
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

To judge `auto` mode properly it has to be served and opened on a real
phone — rotation and fullscreen can't be tested in a desktop frame:

```bash
node -e "const h=require('http'),f=require('fs'),p=require('path');h.createServer((q,s)=>{const n=q.url.split('?')[0]==='/'?'/index.html':q.url.split('?')[0];f.readFile(p.join(process.cwd(),n),(e,d)=>{if(e){s.writeHead(404);return s.end()}s.writeHead(200,{'Content-Type':n.endsWith('.html')?'text/html':'text/plain'});s.end(d)})}).listen(8080,'0.0.0.0',()=>console.log('http://<lan-ip>:8080'))"
```

Run it from this directory, then open `http://<host-lan-ip>:8080/` on the
phone. Add `?variant=A`…`F` to force a single framed layout instead.

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
- Bottom-center bar cycles `auto` → A → … → F — click the arrows or press
  `←`/`→`. In `auto` it shows which layout is live and the detected
  orientation.
- **`proto ▾` (top-left)** collapses all prototype chrome, so the client can
  be seen unobstructed. It starts collapsed on viewports under 700px, which
  is every phone.
- The controls panel has a live readout of viewport size, detected
  orientation, and fullscreen state — useful when driving this on a real
  device where the numbers aren't otherwise visible.

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

- **Landscape layout — decided: D (split rail).** Picked by the user on a
  real device, with the rail narrowed to 132px. E was the only variant that
  removed scrolling entirely at 844×390 (splitting code from prose halves
  the vertical extent) and F preserved C's framing most faithfully, but
  both lost: E gives up a single readable answer column, and F pays a
  two-axis scrolling cost — vertical inside a card *plus* horizontal
  between cards — in the orientation with the least vertical room.

- **Orientation is handled automatically, not chosen.** `auto` mode listens
  on `matchMedia("(orientation: landscape) and (min-width: 600px)")` and
  re-renders on change, so rotating the phone mid-stream swaps C↔D live
  with no reload and no interruption to the stream. The `min-width` clause
  is deliberate: a narrow desktop window that happens to be landscape still
  reads better as the log, so the rule keys off *shape*, not device type.

- **Rotation exposed a state-model mismatch between the two layouts.** D has
  an explicit live-vs-history pane; C does not — an expanded past entry
  there is just expanded, and the live entry is still live. Carrying D's
  `paneMode: "history"` into C unchanged left C's live entry showing a
  history-coloured status dot next to the label "live". Resolved by
  normalising on the way into C: drop the history pane mode, keep *which*
  entry was open, and it lands as an expanded card. **Any real
  implementation needs this normalisation** — it is not free, and it is the
  one non-obvious cost of switching layouts on rotation rather than picking
  one and holding it.

- **Fullscreen is available in both layouts** — a FAB above settings in C,
  a rail-footer button in D — via the standard Fullscreen API with a
  `webkit` fallback, and the icon reflects current state. **Confirmed
  working on the target device** (Android Chrome).

  Known limitation, not hit here: Safari on *iPhone* has never exposed the
  Fullscreen API for arbitrary elements. The button is feature-detected and
  renders visibly disabled with an explanatory tooltip rather than failing
  silently. If an iPhone ever matters, the route to chrome-less display is
  "Add to Home Screen" plus a `display: standalone` manifest — a different
  mechanism, not prototyped.

- **The forced-variant trap, worth carrying into the real client.** During
  device testing the landscape layout appeared stuck on a portrait phone.
  The detection was correct throughout; a stale `?variant=D` in the URL was
  overriding it, and the switcher had been writing that param back on every
  use so it survived reloads and address-bar autocomplete. Two fixes, both
  general lessons: **a debug override must be visually obvious whenever it
  is active** (the badge now reads amber `FORCED D` instead of looking
  identical to normal operation), and **an override must not persist itself
  into the URL** unless explicitly asked for. Also worth noting the
  throwaway server sent *no* cache headers, which could independently have
  masked any fix behind a cached page — `serve.js` now sends `no-store`.

## Capture

Full variant set committed to the throwaway branch `prototype/21-web-client`
per `/prototype`; this README's "What it settled" section is the answer
folded into [The web client (#21)](https://github.com/jpka/screen-solver/issues/21)'s
resolution comment. Nothing here is promoted to `main` — the variant code was
written under prototype constraints (no tests, no error handling) and the
real client should be written fresh against the decisions, not lifted from
this file.
