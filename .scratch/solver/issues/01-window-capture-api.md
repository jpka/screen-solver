# Window capture on Windows 11

Parent: [Screen Solver](../map.md)
Type: research
Status: resolved
Blocked by: —

## Question

Which Windows API can reliably capture a **specific window by handle** on Windows 11, and what are its constraints?

The map has already settled that the user picks a named window from a list and the app captures that window — not the full screen, not a fixed region. This ticket establishes whether that is actually achievable and at what cost.

Cover:

- **The candidate APIs.** `PrintWindow` (with and without `PW_RENDERFULLCONTENT`), Windows.Graphics.Capture (WinRT, Win10 1803+), and desktop-duplication-plus-crop. What each one can and cannot do.
- **The GPU-accelerated Chrome problem.** `PrintWindow` is widely reported to return black or partial frames for GPU-composited browser windows. Is that still true on current Chrome/Edge on Windows 11? Which API avoids it?
- **Occlusion and background windows.** Can the window be captured while partially covered by another window, or while not focused? Which APIs require the window to be visible?
- **Minimized and virtual desktops.** What happens when the target window is minimized or sits on another virtual desktop — black frame, stale frame, error, or last-composited content?
- **Per-monitor DPI.** How captured pixel dimensions relate to logical window size across mixed-DPI monitors, and what has to be accounted for.
- **Runtime reach.** Which of these APIs are reachable from a Node/Electron process (`desktopCapturer` and what it wraps), from Rust/Tauri (which crates, and are they maintained), and what a native path would require. This is what unblocks the stack decision in ticket 02.
- **Capture-indicator side effects.** Whether any approach draws a yellow border or system recording indicator around the captured window, which would be visually intrusive for an always-on tool.

Land on a recommendation: the API to target, and the runtimes that can reach it.

## Notes

Findings: [`../research/window-capture.md`](../research/window-capture.md).

## Answer

**Target Windows.Graphics.Capture (WGC), not `PrintWindow`.** Even with the undocumented `PW_RENDERFULLCONTENT` flag, `PrintWindow`'s black-frame problem on GPU-composited Chrome/Edge is confirmed by Chromium's own graphics-dev mailing list and remains unreliable. WGC captures the DWM-composited surface directly, sidestepping the black-frame problem, tolerating occlusion and background windows, and returning physical-pixel-correct frames with no manual DPI math.

**Runtime reach — the key input for ticket 02:** tracing Electron's `desktopCapturer` down through Chromium's WebRTC `desktop_capture` module shows it is backed by `WgcCapturerWin` on Windows — `desktopCapturer` already uses WGC under the hood, ships prebuilt with no compiler needed, and is the best fit for this machine (Node 24, no Rust/.NET/C++ toolchain). It has documented quirks: minimized or non-standard windows sometimes missing from `getSources`, and multi-monitor enumeration bugs (cited GitHub issues in the findings doc). A lighter alternative worth a spike: `node-screenshots` (npm), a prebuilt addon wrapping the actively-maintained Rust `xcap` crate — no local Rust toolchain needed, but its exact Windows backend wasn't confirmed from docs and should be verified empirically. The Rust crates (`windows-capture`, `xcap` directly) and native C#/C++ WGC interop are ruled out given no Rust/.NET/C++ toolchain is installed.

**Two constraints for whoever makes the stack decision (ticket 02):**

- **Minimized / other virtual desktop:** no live composited surface exists, so WGC most likely holds the last frame (stale, not black) rather than erroring — well-corroborated by community sources but not an explicit Microsoft guarantee. The app needs to detect "not capturable" state itself (e.g. `IsIconic`) rather than trust frame freshness.
- **System yellow border:** WGC draws a system capture-indicator border around the target window on Windows 11 22H2+ (local-display only, never in the captured image itself). It can in principle be suppressed via `GraphicsCaptureSession.IsBorderRequired`, but that requires the restricted `graphicsCaptureWithoutBorder` package-manifest capability plus explicit user consent — normally an MSIX/Store-packaging concept. Whether an unpackaged Electron app can obtain it at all is unconfirmed and needs a direct spike.
