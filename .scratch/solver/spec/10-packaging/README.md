# Packaging, auto-start, and updates — spec fragment

Backs [ticket #10, "Packaging and distribution"](https://github.com/jpka/screen-solver/issues/10)
on the [Screen Solver map](https://github.com/jpka/screen-solver/issues/1). The reasoning
lives in the ticket's resolution comment; this directory holds the parts that are
directly paste-able into the build.

- [`electron-builder.yml`](electron-builder.yml) — the packaging config, annotated with the
  two settings that are load-bearing rather than cosmetic (`deleteAppDataOnUninstall`,
  and the frozen `appId`/`productName` pair that pins `%APPDATA%`).
- `main-process.md` (below) — the three main-process behaviors packaging forces.

## Main-process behaviors packaging forces

### 1. Single-instance lock — this is a budget control

Auto-start plus a manual launch gives you two copies of the capture loop against the
same window, each with its own `BudgetGuard` and its own `usage.json` writes. Two loops
is two bills, and #9's limits are per-process so neither one sees the other's spend.

```ts
if (!app.requestSingleInstanceLock()) {
  app.quit();          // hand off to the running instance
} else {
  app.on("second-instance", () => { /* focus the existing output window */ });
}
```

Not optional. Register it before anything else in `main`.

### 2. Auto-start: opt-in, off by default, starts paused

```ts
// only meaningful in a packaged build — in dev, app.getPath("exe") is electron.exe
if (app.isPackaged) {
  app.setLoginItemSettings({
    openAtLogin: config.autoStart,     // default false
    path: app.getPath("exe"),
    args: ["--autostart"],
  });
}

const autoStarted = process.argv.includes("--autostart");
```

Writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` — per-user, no admin, no
MSIX `StartupTask`. `openAsHidden` is macOS-only; the `--autostart` flag is how the
main process learns it was launched by Windows rather than by the user.

When `autoStarted` is true the loop starts in #9's **paused** state. The user resumes
deliberately. An app that begins spending money and painting a yellow border around a
browser window before anyone has looked at it is the failure #9 spends five nested
limits guarding against.

### 3. One long-lived capture session, not one per tick

The Windows 11 capture indicator (the yellow border) is drawn for the lifetime of the
WGC session. Opening a session per capture tick makes the border strobe at the poll
interval — far more intrusive than a steady outline. Open the session once when the
target window is resolved, hold it across ticks, close it on pause / window change /
quit.

This is also what makes the border useful: it is a free, always-accurate,
OS-drawn "this window is being watched" indicator that disappears the moment the user
pauses. #9's idle slow-poll keeps the session open (border stays); pause closes it
(border goes).
