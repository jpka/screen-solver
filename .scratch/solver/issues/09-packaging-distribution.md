# Packaging and distribution

Parent: [Screen Solver](../map.md)
Type: grilling
Status: open
Blocked by: 02

## Question

How does Screen Solver get built, installed, and updated?

Ticket 02 settled the stack as Electron + TypeScript. That makes this question sharp: Electron apps can ship unpackaged (run from source / `electron .`), as a plain installer (electron-builder/electron-forge NSIS or portable exe), or as an MSIX package.

The MSIX question has a real second consequence beyond installation UX: ticket 01 found that suppressing WGC's yellow capture-indicator border requires the `graphicsCaptureWithoutBorder` restricted capability, which is normally an MSIX/Store-packaging concept — whether an unpackaged app can get it at all was flagged as unconfirmed and needing a direct spike. That spike belongs here, since it's packaging that gates the answer.

Decide:

- **Packaging format.** Unpackaged (dev-mode-style), a conventional installer (electron-builder NSIS/portable), or MSIX. Weigh install friction for a single personal-machine tool against the border-suppression capability MSIX would unlock.
- **Border-suppression spike.** Try `GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless)` from whichever packaging format is chosen and confirm whether the OS honors it. If it doesn't, the yellow border ships as permanent, expected behavior (ticket 01's fallback conclusion).
- **Auto-start on login.** Whether the app launches at Windows startup, and how that's registered for the chosen packaging format.
- **Update path.** Manual rebuild-and-reinstall, `electron-updater` against a self-hosted release feed, or no update mechanism at all for a personal tool. Justify against how often this app is expected to change post-v1.

Deliverable: packaging format, auto-start behavior, and update path, plus the outcome of the border-suppression spike (or a decision to skip the spike and accept the border as permanent).
