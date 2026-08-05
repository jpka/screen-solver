# The output window

Parent: [Screen Solver](../map.md)
Type: prototype
Status: resolved
Blocked by: 02

## Question

What does the app's own window look like, and how does an answer arrive in it?

Build a rough, throwaway prototype to react to — this is a "how should it look and behave" question, so a sketch beats a discussion.

Work out:

- **Layout.** What's on screen: the current answer, a status line, the history, access to settings. What dominates.
- **Streaming render.** The answer arrives token by token. Does it stream into place, or appear when complete? How is a long code block handled while it's still arriving — does the pane scroll itself, and what does that feel like while you're reading?
- **Code presentation.** Answers to katas are mostly code. Syntax highlighting, monospace, wrapping vs horizontal scroll.
- **State the window has to show.** Idle / watching / capturing / thinking / streaming / errored — and how each reads at a glance without being noisy.
- **What happens on a new problem** while an answer is still streaming. Interrupt and replace, or queue.
- **History.** Whether previous answers stay reachable, and how you get back to one.
- **Window behavior.** Always-on-top or not, default size, whether it remembers position.

Deliverable: a linked prototype plus the decisions it settled. Note that ticket 02 decides the UI technology — build the prototype in whatever that turns out to be, so the throwaway is still informative.

## Answer

Built [three structurally different variants](../prototypes/06-output-window/) as a throwaway HTML/CSS/JS page (the renderer is plain web tech regardless, so no Electron scaffold was needed to judge layout/streaming/feel) — a mock streaming engine and a "PROTOTYPE CONTROLS" panel (new problem / simulate error / reset) let each variant be exercised interactively. Verified all three render and behave correctly in-browser before handing off.

**Variant A — Focus pane — wins.** One big current-answer pane dominates the window; history and settings are tucked behind icons in the custom titlebar.

Settled, working through the ticket's question list:

- **Layout.** Custom titlebar (drag region, pin/history/settings icons) + one large scrollable answer pane. Nothing else competes for attention.
- **Streaming render.** Code streams in first, then the explanation, both revealed progressively with a blinking cursor. The pane auto-scrolls to follow new content; if the user scrolls up mid-stream, auto-scroll pauses (their reading position is preserved) — reserved for a "jump to latest" affordance rather than fighting the user's scroll.
- **Code presentation.** Monospace, syntax-highlighted (the prototype's own tokenizer is a placeholder — pick a real highlighting library at implementation time). **Long lines wrap** rather than horizontal-scrolling, so nothing requires side-scrolling to read.
- **State display.** A single status pill in the titlebar (idle / watching / capturing / thinking / streaming / errored), color-coded with a pulsing dot for active states — one glance, no separate indicators competing for attention.
- **New problem while streaming.** Interrupts and replaces immediately. The interrupted partial answer is pushed into history, tagged `interrupted`, rather than discarded.
- **History.** A history icon opens a slide-over drawer listing past entries (title, timestamp, status badge — done / interrupted / errored). Clicking an entry shows it in the main pane in a "viewing history" mode; a new live answer arriving while viewing history does not yank the view away.
- **Window behavior.** **Always-on-top by default** (the whole point is glancing at it while the kata sits in another window), with the prototype's pin icon as a manual toggle. **Remembers size and position** across restarts rather than resetting to a fixed default each launch.

Losing variants (B — sidebar timeline with a solve queue; C — chronological log/transcript with no separate "current answer") are preserved in the same prototype file, switchable via `?variant=B`/`?variant=C` in the page's own in-app switcher (arrow buttons / `←`/`→`), for reference — not promoted.
