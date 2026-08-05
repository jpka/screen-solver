# Prototype — the output window (ticket 06)

PROTOTYPE — throwaway. Answers "what does the app's own window look like, and how does an answer arrive in it?"

Three variants of the output window, switchable via `?variant=`, on a single throwaway page (sub-shape B — the app has no real pages yet).

- **A — Focus pane**: one big current-answer pane dominates; history and settings tucked behind icons; new problem **interrupts and replaces**.
- **B — Sidebar timeline**: persistent history sidebar, main pane shows whichever entry is selected; new problem **queues** behind the one in flight.
- **C — Log / transcript**: one continuous chronological feed, no separate "current answer" concept — the latest block *is* the log; new problem **appends**, interrupted entries stay visible dimmed.

## Run it

No build step — it's a single static HTML file with inline JS, standing in for an Electron renderer (plain HTML/CSS/JS either way).

```bash
start .scratch/solver/prototypes/06-output-window/index.html
```

(or just double-click `index.html`)

## Using it

- A demo problem streams in automatically ~1s after load.
- Bottom-center bar switches variants — click the arrows or press `←`/`→`.
- Top-right **PROTOTYPE CONTROLS** panel: "New problem" (fires mid-stream to compare interrupt vs. queue vs. append), "Simulate error", "Reset".
- Window chrome (always-on-top pin, drag titlebar) is mocked visually — can't be truly tested outside a real Electron window, called out inline where it appears.
