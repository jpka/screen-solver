# App shell and stack

Parent: [Screen Solver](../map.md)
Type: grilling
Status: resolved
Blocked by: 01

## Question

What does this app get built with?

The choice is constrained from two directions: it must reach whichever capture API ticket 01 lands on, and it must render a streaming text UI in its own always-available window.

Weigh at least:

- **Electron** — Node 24 and npm are already installed, `desktopCapturer` is the built-in window-source primitive, and streaming text into a renderer is trivial web work. Ships fat (~150MB), which may not matter for a personal tool.
- **Tauri** — small binary, but needs a Rust toolchain that isn't installed, and window capture comes from a third-party crate whose maintenance status ticket 01 should have established.
- **Native (C# / WinUI or C++)** — most direct access to Windows.Graphics.Capture, but no .NET SDK is installed and the streaming-text UI is more work.

Decide on:

- the shell and language,
- how the capture layer is reached from it (in-process, native addon, sidecar binary),
- whether the capture loop and the UI live in one process or two.

The answer constrains tickets 05, 06, and 07 — say enough that those can proceed.

## Answer

**Electron + TypeScript.** Electron wins over Tauri and native because ticket 01 already found that its built-in `desktopCapturer` is transitively WGC-backed via Chromium's `WgcCapturerWin` — the exact API the research recommended — reachable with zero additional toolchain installs on this machine (Node 24/npm only; no Rust or .NET SDK needed for Tauri or native). TypeScript over plain JS because this app has real interface boundaries worth catching at compile time: the provider seam (ticket 04) and the main/renderer IPC contract below.

**Process architecture:** capture and the LLM-call loop live entirely in Electron's **main process** — `desktopCapturer.getSources()`, the interval timer, the change-detection diff (ticket 05), and the streaming Anthropic API call all run there. The **renderer** is a thin output window that only receives capture-state and streamed-answer events over IPC (`ipcMain`/`ipcRenderer` or a preload-exposed channel) and displays them — it never touches the capture API or the network call directly.

This isn't a deliberate one-vs-two-process split — Electron enforces the main/renderer split by construction — the decision is that main owns everything capture- and network-related. Reasons: `desktopCapturer` needs main-process access, keeping the API key and outbound network calls out of the more-exposed renderer is a better security posture, and it keeps ticket 07's key-storage decision simpler since the key never needs to cross into renderer-land.
