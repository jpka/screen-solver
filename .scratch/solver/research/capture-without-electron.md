# Capture without Electron: does `node-screenshots` replace `desktopCapturer`?

**Research date:** 2026-08-06
**Scope:** Follow-up to [`window-capture.md`](./window-capture.md), which recommended Electron's `desktopCapturer` because it is transitively WGC-backed, and explicitly left `node-screenshots`/`xcap` unverified: *"its exact Windows backend wasn't confirmed from docs and should be verified empirically."* Now that the output surface is a local server plus a browser client, capture is Electron's only remaining job, so the question is whether a plain-Node native addon can take it over.

**Method and its limits.** This research was done on a Linux container. **No claim below was observed running on Windows 11.** What *was* done directly: the `xcap` and `node-screenshots` sources were cloned and read, the exact `xcap` version `node-screenshots` depends on was downloaded from crates.io and read, and the **published npm binaries were downloaded and their PE import tables disassembled**. Those are first-hand observations about the shipped artifact, and they are labelled **[verified-from-artifact]**. Everything about *runtime pixel behaviour on Windows* is labelled **[inferred]** or **[unresolvable here]**, with the settling test named. Figures measured in this container are labelled **[measured-here]**.

---

## Bottom line up front

**1. The backend is `PrintWindow`, not WGC.** `node-screenshots@0.2.8` depends on `xcap = "0.4.1"` with only the `image` feature. `xcap` 0.4.1 has **no WGC code at all** — its `capture_window` is a `PrintWindow`/`BitBlt` GDI chain whose first attempt is the undocumented `PW_RENDERFULLCONTENT` flag. This is precisely the code path `window-capture.md` §2 recommended against, using precisely the undocumented workaround it called unreliable. The published `.node` binary's import table confirms it: `PrintWindow`, `BitBlt`, `GetWindowDC`, `GetDIBits`, `DwmIsCompositionEnabled` are imported; `combase.dll`, `d3d11.dll` and `dxgi.dll` are **not imported at all**, so no WGC path is even compiled in. [§1]

**2. It needs no Rust toolchain.** Prebuilt, no-compile install is real and confirmed from the tarballs: PE32+ DLLs ship for `win32-x64` and `win32-arm64` (and `win32-ia32`), there is no `install`/`postinstall` script, and the loader is a plain `require()` with no `node-gyp`, no `prebuild-install`, and no network fallback. This part of the map's earlier assumption holds. [§7]

**The two answers point in opposite directions, and #1 wins.** The toolchain question was the reason to hope; the backend question is the reason to stop. Adopting `node-screenshots` would mean betting the product's core function on an undocumented Win32 flag against the exact application class (GPU-composited Chromium) that flag is least reliable for — and doing so with **no error signal when it fails**, because `PrintWindow` returns success for a black bitmap (§2.2). For an app that pays a vision LLM per frame ([#9](https://github.com/jpka/screen-solver/issues/9)), a silent black frame is a silent bill.

**Recommendation: keep Electron for capture.** The lever that would flip this is named in §11 — it is not "wait for upstream", it is "vendor a build of `xcap >= 0.8.3` with `features = ["wgc"]`", and it costs a build pipeline.

---

## 1. The Windows backend — answered from source

### 1.1 The dependency chain

`node-screenshots` does not use current `xcap`. Its `Cargo.toml` pins:

```toml
xcap = { version = "0.4.1", features = ["image"] }
```

[`node-screenshots/Cargo.toml`](https://github.com/nashaofu/node-screenshots/blob/master/Cargo.toml) **[verified-from-artifact]** — read from a clone at commit `c74c32b` (2026-02-07, the repository's most recent commit).

Under Cargo's caret semantics `"0.4.1"` resolves within `0.4.x` only. So the shipped binary is built against `xcap` **0.4.1, published 2025-03-23** ([crates.io versions API](https://crates.io/api/v1/crates/xcap/versions)) — around **16 months** older than the current `xcap` 0.9.8 (2026-08-01). **[measured-here]**

### 1.2 `xcap` 0.4.1 has no WGC code

The 0.4.1 crate was downloaded from crates.io (`https://static.crates.io/crates/xcap/xcap-0.4.1.crate`) and unpacked. **[verified-from-artifact]**

- Its `[features]` table contains exactly two entries: `image` and `vendored`. There is **no `wgc` feature**.
- `src/windows/` contains `capture.rs`, `impl_monitor.rs`, `impl_video_recorder.rs`, `impl_window.rs`, `mod.rs`, `utils.rs`. There is **no `wgc.rs`**.
- Its Windows `windows` crate feature list includes `Win32_Storage_Xps` (which is where `PrintWindow` lives in `windows-rs`) and `Win32_Graphics_Gdi`. It does **not** include `Graphics_Capture` or `Win32_System_WinRT_Graphics_Capture`.

### 1.3 What `capture_window` actually calls

`xcap-0.4.1/src/windows/capture.rs`, `pub fn capture_window(hwnd: HWND, scale_factor: f32)` — the capture attempt, verbatim: **[verified-from-artifact]**

```rust
let mut is_success = false;

// https://webrtc.googlesource.com/src.git/+/refs/heads/main/modules/desktop_capture/win/window_capturer_win_gdi.cc#301
if get_os_major_version() >= 8 {
    is_success = PrintWindow(hwnd, *scope_guard_hdc_mem, PRINT_WINDOW_FLAGS(2)).as_bool();
}

if !is_success && DwmIsCompositionEnabled()?.as_bool() {
    is_success = PrintWindow(hwnd, *scope_guard_hdc_mem, PRINT_WINDOW_FLAGS(0)).as_bool();
}

if !is_success {
    is_success = PrintWindow(hwnd, *scope_guard_hdc_mem, PRINT_WINDOW_FLAGS(4)).as_bool();
}

if !is_success {
    is_success = BitBlt(/* … from GetWindowDC(hwnd) … */, SRCCOPY).is_ok();
}
```

Reading this:

- `PRINT_WINDOW_FLAGS(2)` is `PW_RENDERFULLCONTENT` — the undocumented flag. Note that `xcap` writes the **raw integer**, not a named constant, because `windows-rs` does not expose one: the `windows-rs` docs for `Win32::Storage::Xps` list only `PW_CLIENTONLY`. ([windows-docs-rs, `Win32/Storage/Xps`](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Storage/Xps/index.html)) **[measured-here]**
- The source comment cites WebRTC's **`window_capturer_win_gdi.cc`** — that is, `xcap` deliberately ported Chromium/WebRTC's **legacy GDI capturer**, not its `WgcCapturerWin`. `window-capture.md` §2 identified `WgcCapturerWin` as the thing that makes Electron work; `xcap` 0.4.1 copied the other file.
- WebRTC's own comment on that flag: *"certain apps (e.g. those using DirectComposition rendering) can't be captured using BitBlt or PrintWindow without this flag."* ([`window_capturer_win_gdi.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/desktop_capture/win/window_capturer_win_gdi.cc))
- `PRINT_WINDOW_FLAGS(4)` has **no name and no documentation anywhere** — not in Microsoft's `nFlags` table, not in `windows-rs`, and not in the WebRTC file `xcap` cites (WebRTC goes `PW_RENDERFULLCONTENT` → `0` → `BitBlt`). This step is `xcap`'s own addition of a magic number. **[verified-from-artifact]**

### 1.4 The published binary confirms it

The strongest evidence, because it describes the artifact `npm install` actually delivers rather than the source it was supposedly built from. `npm pack node-screenshots-win32-x64-msvc@0.2.8` and `objdump -p` on the extracted `.node`: **[verified-from-artifact / measured-here]**

Imported DLLs, complete list:

```
kernel32.dll  user32.dll  psapi.dll  version.dll
api-ms-win-core-synch-l1-2-0.dll  ntdll.dll  oleaut32.dll
dwmapi.dll  advapi32.dll  gdi32.dll  bcryptprimitives.dll  KERNEL32.dll
```

Relevant imported symbols:

| DLL | Symbols |
|---|---|
| `user32.dll` | `PrintWindow`, `GetWindowDC`, `ReleaseDC`, `EnumWindows`, `IsIconic`, `IsZoomed`, `GetForegroundWindow`, `GetWindowInfo`, `GetWindowTextW`, `GetClassNameW`, … |
| `gdi32.dll` | `BitBlt`, `GetDIBits`, `CreateCompatibleDC`, `CreateCompatibleBitmap`, `SelectObject`, `GetCurrentObject`, `GetObjectW` |
| `dwmapi.dll` | `DwmIsCompositionEnabled`, `DwmGetWindowAttribute` |

**Absent:** `combase.dll` / `api-ms-win-core-winrt-*` (WinRT activation), `d3d11.dll`, `dxgi.dll`. A `strings` scan for `Graphics.Capture`, `RoGetActivationFactory` and `D3D11CreateDevice` returns **zero hits** in both the x64 and arm64 binaries. The arm64 `.node` (which `objdump` cannot parse the import table of) contains the identical GDI symbol strings: `PrintWindow`, `BitBlt`, `GetWindowDC`, `GetDIBits`, `DwmIsCompositionEnabled`, `CreateCompatibleBitmap`.

**There is no Windows.Graphics.Capture code in the shipped binary.** Not disabled, not fallback — not present.

### 1.5 Current `xcap` *does* have WGC, but `node-screenshots` cannot reach it

Current `xcap` (0.9.8) gained a Windows WGC implementation: `src/windows/wgc.rs` uses `factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()`, `interop.CreateForWindow(hwnd)`, `Direct3D11CaptureFramePool::CreateFreeThreaded`, `session.StartCapture()` — the documented WGC model. **[verified-from-artifact]** ([`xcap/src/windows/wgc.rs`](https://github.com/nashaofu/xcap/blob/master/src/windows/wgc.rs))

But three things gate it:

1. **It is an opt-in Cargo feature, off by default.** `xcap`'s `[features]` block defines `wgc = [...]` with no `default` list including it. `src/windows/mod.rs` gates the module on `#[cfg(feature = "wgc")]` and gates `gdi`/`dxgi_video_recorder` on `#[cfg(not(feature = "wgc"))]` — the two backends are mutually exclusive at compile time.
2. **It is undocumented.** A `grep` for `wgc` across every `.md`, `.yml` and `.yaml` in the `xcap` repository returns **nothing**. It is not in the README, not in the feature matrix, not in CI. It is discoverable only by reading `Cargo.toml`. **[measured-here]**
3. **It postdates `node-screenshots`.** The WGC commit is `c705483` *"feat: windows 截图支持wgc (#257)"*, **2026-03-01**, first released in `xcap` **v0.8.3**. `node-screenshots`' most recent commit is **2026-02-07** and its most recent publish is **0.2.8, 2026-02-07**. **[measured-here]** The binding has never existed in a world where `xcap` had WGC, and its `^0.4.1` pin is four minor series behind the version that introduced it.

---

## 2. Correctness on the actual target (Chrome/Edge, GPU-composited)

### 2.1 The honest answer

**[unresolvable here]** — whether a specific Windows 11 machine's Chrome window comes back as real pixels or a black rectangle through `PW_RENDERFULLCONTENT` cannot be determined without running it on that machine. What *is* settled is that `node-screenshots` offers **no structural protection** against the failure: it is on the GDI path, and its only mitigation is the undocumented flag.

**The test that settles it** (10 minutes on the target box):

```js
const { Window } = require('node-screenshots')
const w = Window.all().find(x => /Chrome|Edge/i.test(x.appName()))
const raw = w.captureImageSync().toRawSync()   // RGBA
let nonBlack = 0
for (let i = 0; i < raw.length; i += 4)
  if (raw[i] | raw[i+1] | raw[i+2]) nonBlack++
console.log(w.appName(), w.title(), raw.length/4, 'px,', nonBlack, 'non-black')
```

Run it four ways, because a single pass proves little: (a) a plain text page, (b) a page playing hardware-decoded `<video>`, (c) a WebGL/`<canvas>` page, (d) with Chrome's `chrome://settings` hardware acceleration toggled off. Then repeat (a)–(c) on a **second** machine with a different GPU vendor. A near-zero `nonBlack` on any of these is a disqualifying result.

### 2.2 The part that *is* settled, and it is the worrying part

**`PrintWindow` returning success does not mean it drew anything.** Microsoft's documented return-value contract is only: *"If the function succeeds, it returns a nonzero value. If the function fails, it returns zero."* ([Microsoft Learn — PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)) There is no documented relationship between the return value and the content of `hdcBlt`. The function's model is to send the target `WM_PRINT`/`WM_PRINTCLIENT` and let the *application* render; an application that renders nothing visible into the DC has not made `PrintWindow` fail.

Consequence for `xcap`'s chain (§1.3): if `PrintWindow(hwnd, dc, 2)` returns TRUE but paints black, **`is_success` is true and every fallback is skipped**. Flags `0` and `4` and the `BitBlt` are dead code in exactly the scenario they exist for. `xcap` then returns a perfectly valid `RgbaImage` full of `(0,0,0,255)`, `node-screenshots` wraps it in an `Image`, `toPngSync()` produces a valid PNG, and nothing anywhere raises an error. **[verified-from-artifact — reading the code and the documented return contract]**

This lands directly on two open tickets:
- [Failure and edge-case behavior (#13)](https://github.com/jpka/screen-solver/issues/13): there is no error to catch. Detection must be the app's job — a non-black-pixel-ratio check on the returned buffer before spending a request.
- [Cost control (#9)](https://github.com/jpka/screen-solver/issues/9): every undetected black frame is a paid vision-LLM call that returns nothing useful.

### 2.3 Does `PW_RENDERFULLCONTENT` work on Chrome? The best available evidence

Only the flag's second-hand reputation is available, and it is genuinely mixed:

- **For it.** The flag exists precisely for this: WebRTC's comment says DirectComposition-rendered apps *"can't be captured using BitBlt or PrintWindow without this flag."* On the Chromium graphics-dev thread `window-capture.md` §2 already cites, the reporter's own summary is that *"since Windows 8.1 there is undocumented flag PW_RENDERFULLCONTENT, which does the trick"* — the black rectangle complaint is about `PrintWindow` **without** it. ([chromium graphics-dev, 2016-09-01 → 2019-03-11](https://groups.google.com/a/chromium.org/g/graphics-dev/c/LrpgdDg7p_8))
- **Against it.** Mozilla investigated using `PrintWindow` + `PW_RENDERFULLCONTENT` to snapshot DirectComposition overlays (Bug 1585619, landed in Firefox 73, Dec 2019). Even **from inside their own compositor**, with the ability to wait on GPU commit completion, Sotaro Ikeda reported *"there is still a case that we could not get correct screenshot"*, the first fix was wrong (`DCLayerTree::WaitForCommitCompletion` calling the wrong method), and the shipped result produced a regression of *"10-second long startup hangs"* (Bug 1615590). ([Mozilla Bug 1585619](https://bugzilla.mozilla.org/show_bug.cgi?id=1585619))

**[inferred from Mozilla Bug 1585619]** The Mozilla experience is the more informative one for this app, and the inference is this: getting correct pixels out of `PW_RENDERFULLCONTENT` for hardware-composited layers required an explicit **synchronisation handshake with the compositor**. Mozilla could perform that handshake because they *were* the compositor. An external process calling `PrintWindow` on someone else's Chrome has no such lever — it cannot wait for Chrome's DirectComposition commit. So the expected failure profile for `node-screenshots` against Chrome is not a clean binary "works / all black" but the worse shape: **chrome (UI, text, DOM) probably renders; hardware-decoded video, WebGL and accelerated canvas layers are the ones at risk of coming back black or stale**, non-deterministically, per frame.

For a *screen solver* — an app whose whole value is reading what is on the page — "the text renders but the embedded media doesn't" may be acceptable or may be fatal depending on the target content. That is a product question the spike in §2.1 case (b)/(c) should answer explicitly, not a technical detail to defer.

### 2.4 `xcap`'s own maintainer added WGC five months ago

**[inferred from repository history]** PR #257 has no description (checked; body is *"No description provided"*), so motivation cannot be quoted. But the shape of the change is evidence in itself: after two years of shipping the GDI path, the maintainer wrote a complete `Windows.Graphics.Capture` implementation and made the two backends mutually exclusive. Since then the WGC path has already needed two fixes — [#265](https://github.com/nashaofu/xcap/pull/265) making `SetIsBorderRequired`/`SetIsCursorCaptureEnabled` non-fatal, and [#278](https://github.com/nashaofu/xcap/pull/278) raising the frame timeout from 200 ms to 3000 ms. Read two ways: the GDI path was not good enough, **and** the WGC replacement is five months old and still settling.

---

## 3. Capture by window identity

**Yes — capture is by `HWND`, and a `Window` object holds it.** **[verified-from-artifact]**

- `xcap`'s Windows window type is literally `pub(crate) struct ImplWindow { pub hwnd: HWND }` ([`impl_window.rs`](https://github.com/nashaofu/xcap/blob/master/src/windows/impl_window.rs)).
- `node-screenshots`' `Window` wraps a cloned `XCapWindow`, so the JS object retains the `HWND` (`node-screenshots/src/window.rs`).
- Every geometry accessor re-queries live: `x()`/`y()`/`width()`/`height()` each call `GetWindowInfo(self.hwnd)` fresh; `capture_image()` calls `capture_window(self.hwnd, …)` fresh.

So a stored `Window` object **does** follow moves and resizes across ticks without re-enumerating — the map's settled constraint is satisfied, and `window-capture.md` §6's guess that you would have to "re-query `Window.all()` each cycle" was pessimistic.

**Two caveats.**

1. `id()` returns `self.hwnd.0 as u32` — the raw handle, truncated. This is exactly the unstable identifier [Configuration and API key storage (#8)](https://github.com/jpka/screen-solver/issues/8) said not to persist. It is fine as an in-session key, useless in a config file.
2. Nothing revalidates the `HWND` before use. If the window closes, `GetWindowInfo` fails and the call surfaces as a thrown `Error` (napi converts `XCapError` via `Error::from_reason`). That is a usable signal for #13 — but see §5, where the *same* signal means "on another virtual desktop".

---

## 4. Window enumeration for the picker

**Sufficient for [#8](https://github.com/jpka/screen-solver/issues/8), with one naming caveat.** **[verified-from-artifact]**

`Window.all()` returns objects exposing `id()`, `pid()`, `appName()`, `title()`, `currentMonitor()`, `x/y/z/width/height()`, `isMinimized()`, `isMaximized()`, `isFocused()` (`index.d.ts`). Sorted by Z order.

**`appName()` is not the process image name.** `get_app_name(pid)` opens the process, reads the executable's **version resource**, and returns the first non-empty value among `FileDescription`, `ProductName`, `ProductShortName`, `InternalName`, `OriginalFilename`, falling back to `GetModuleBaseNameW` only if the version info is unreadable. **[inferred from that ordering]** For Chrome this yields `"Google Chrome"`, not `"chrome.exe"`. Arguably better for a human-facing picker; just do not write the persistence layer expecting `.exe`.

**Enumeration filters** (`is_valid_window`, ported from WebRTC's `window_capture_utils.cc`) drop: non-`IsWindow`/non-`IsWindowVisible` windows; windows with an empty class name; `WS_EX_TOOLWINDOW` windows with no title (except `Shell_TrayWnd`); **windows owned by the calling process**; `Progman`; `Button`; **DWM-cloaked windows**; and windows whose `DWMWA_EXTENDED_FRAME_BOUNDS` rect is empty.

The own-process exclusion is worth noting as a *contrast with Electron*: `window-capture.md` §6 lists Electron's historical bug of excluding the app's own windows from `getSources`. `xcap` does it **deliberately**, with an in-source rationale (the WebRTC deadlock comment about `GetWindowText*` blocking on same-process windows). Not a problem here — the target is always Chrome — but it means "capture my own UI" is off the table by design.

---

## 5. Occluded, minimized, and other-virtual-desktop windows

### Occluded
**[inferred from the API model]** `PrintWindow` asks the target application to render into an off-screen DC; it does not sample the screen, so occlusion should not corrupt the result — this is `PrintWindow`'s one genuine advantage over `BitBlt`-from-screen and over desktop-duplication-plus-crop (`window-capture.md` §3). The `BitBlt`-from-**window**-DC last-resort branch *would* be occlusion-sensitive, but per §2.2 it is nearly unreachable. Net: occlusion is probably fine; the black-frame risk (§2) is orthogonal and dominates.

### Minimized
**[unresolvable here]** — but the API gives you what you need to not care. `isMinimized()` is a direct `IsIconic(hwnd)` and is exposed to JS, so the app can gate the capture cycle on it before spending anything. `window-capture.md` §4 already established the OS-level constraint (a minimized window is not composed, so *no* API has a live surface) and `xcap`'s own examples note minimized windows cannot be screenshotted.

The open question is what `captureImageSync()` *returns* for a minimized window — plausible outcomes are a black bitmap, a garbage bitmap, or a thrown error, and the code does not settle it. **Settling test:** capture a Chrome window, minimize it, capture again, compare buffers and check for a throw. **Regardless of the result, gate on `isMinimized()`** — it is the cheap, documented check and it removes the question from the hot path.

Note also that minimized windows may still appear in `Window.all()`: `is_valid_window` filters on `IsWindowVisible` (which stays true when minimized) and on non-empty `DWMWA_EXTENDED_FRAME_BOUNDS`, not on `IsIconic`. **[inferred from the filter list]** So the picker will likely list them and the app must label them.

### Other virtual desktop
**[inferred, two steps]** `is_valid_window` rejects any window where `DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, …)` returns non-zero. Microsoft documents `DWM_CLOAKED_SHELL` (0x2) as *"The window was cloaked by the Shell"* ([Microsoft Learn — DWMWINDOWATTRIBUTE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)) but does **not** state that virtual desktops are implemented via shell cloaking — that connection is community knowledge, not documentation. (The *documented* way to answer "is this window on the current desktop" is [`IVirtualDesktopManager::IsWindowOnCurrentVirtualDesktop`](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ivirtualdesktopmanager-iswindowoncurrentvirtualdesktop), which `xcap` does not call.)

If the inference holds, the behaviour is: **a Chrome window moved to another virtual desktop disappears from `Window.all()`.** For #13 that is a *good* failure mode — the app stops rather than silently capturing stale content — but it is **indistinguishable from "the user closed the window"**, so the UI cannot tell the user which happened. **Settling test:** enumerate, move the Chrome window to virtual desktop 2, switch back to desktop 1, enumerate again, and check whether the window and its `id()` are still present.

### The stale-frame question, directly
Ticket #9 frames this as a money question: *"solving a stale frame spends real money on nothing."* The structural answer for the GDI path: **`PrintWindow` has no frame pool and no concept of staleness.** Each call synchronously asks the app to repaint *now*. There is no last-good-frame buffer to be handed back — which is a real advantage over WGC's frame-pool model, where `window-capture.md` §4 flagged exactly the stale-frame risk. The GDI path's failure mode is **black**, not **stale**. That is easier to detect programmatically (a pixel-ratio check catches black; nothing catches stale), and it is the one place where this backend is *better* behaved than WGC.

---

## 6. DPI scaling

**[verified-from-artifact for the logic; unresolvable here for the resulting pixel dimensions]**

`xcap` 0.4.1's `ImplWindow::capture_image` computes a scale factor before capturing:

```rust
let window_is_dpi_awareness = get_process_is_dpi_awareness(target_process)?;
let current_process_is_dpi_awareness = get_process_is_dpi_awareness(GetCurrentProcess())?;

let scale_factor = if !window_is_dpi_awareness {
    1.0
} else if current_process_is_dpi_awareness {
    1.0
} else {
    self.current_monitor()?.scale_factor()?
};
```

`get_process_is_dpi_awareness` is a runtime `LoadLibrary("Shcore.dll")` + `GetProcAddress("GetProcessDpiAwareness")`, treating any non-`PROCESS_DPI_UNAWARE` value as aware.

Then `capture_window` layers three more heuristics on top: it starts from `rcWindow`, **overrides** those dimensions with the window DC's current bitmap dimensions if `GetObjectW` succeeds, multiplies by `scale_factor`, and finally crops to `rcClient` offsets scaled by the same factor. (Current `xcap` 0.9.8 restructured this again — it now does a full `DynamicImage::resize` with a CatmullRom filter before cropping, and special-cases dialog class `#32770` — which is itself a signal that the geometry has been repeatedly wrong.)

**What this means in practice.** Node is normally launched without a DPI-awareness manifest, so the capturing process is DPI-unaware while Chrome is per-monitor-aware. **[inferred]** That puts the code on its third branch — scale by the monitor's factor — and, because a DPI-unaware process sees *virtualised* (logical) window rectangles from `GetWindowInfo`, the multiplication is what is supposed to recover physical pixels. Whether it lands exactly is not determinable from reading: there are four interacting heuristics and a documented-DPI-virtualisation layer between them.

Two further consequences worth planning around regardless of backend, both carried over from `window-capture.md` §5:
- `xcap` 0.4.1 crops the output to the **client** rectangle, so the returned image excludes the window frame. For Chrome (custom-drawn frame) that is roughly what you want; do not assume it matches `width()`/`height()`, which also report `rcClient`.
- Moving the window between monitors with different scale factors changes the returned pixel dimensions between ticks even when the logical size is unchanged. The vision-LLM pipeline must tolerate variable input resolution or normalise before sending.

**Settling test:** on a 150 %-scaled display, capture a Chrome window of known logical size and assert `image.width === Math.round(logicalWidth * 1.5)`; repeat at 100 %, and repeat after dragging the window between two monitors with different factors. Then run the same test from a Node process launched with `SetProcessDpiAwarenessContext` applied (or a manifest), since the second branch above changes the answer.

---

## 7. Toolchain cost — no Rust, no compiler, confirmed from the published packages

**Answer: `npm install` compiles nothing on Windows.** **[verified-from-artifact / measured-here]**

Evidence, all from tarballs pulled with `npm pack` in this container:

| Package | Size | Contents |
|---|---|---|
| `node-screenshots@0.2.8` | 6.0 KB | `index.js`, `index.d.ts`, `package.json`, `README.md`, `LICENSE` — **no binary, no scripts dir** |
| `node-screenshots-win32-x64-msvc@0.2.8` | 320 KB | `node-screenshots.win32-x64-msvc.node` (700,928 bytes) |
| `node-screenshots-win32-arm64-msvc@0.2.8` | 295 KB | `node-screenshots.win32-arm64-msvc.node` (628,224 bytes) |

`file` on both binaries: `PE32+ executable (DLL) (GUI) x86-64` and `PE32+ executable (DLL) (GUI) Aarch64`, `for MS Windows`. These are finished, linked Windows DLLs. **Both `win32-x64` and `win32-arm64` ship**, plus `win32-ia32` declared in `optionalDependencies`.

- **No lifecycle scripts.** The published root `package.json`'s `scripts` block contains no `preinstall`, `install`, or `postinstall`. (`prepare: husky` is present but npm only runs `prepare` for the root package and for git-URL dependencies, never for a registry tarball installed as a dependency.)
- **No compile or download fallback.** `index.js` is the standard napi-rs loader: a `process.platform`/`process.arch` switch that tries `require('./node-screenshots.win32-x64-msvc.node')` then `require('node-screenshots-win32-x64-msvc')`. Grepping it for `node-gyp`, `prebuild`, `download`, or an outbound `https` fetch returns nothing. The single `child_process.execSync` call is `ldd --version` for Linux musl detection and never executes on Windows. A WASI branch exists but `node-screenshots-wasm32-wasi` is not published, so it can only produce an error, never a build.
- **Zero runtime dependencies** beyond the platform optionalDependency.
- **Node 24 is supported.** `engines.node` is `>= 16.0.0`; the repository's CI (`.github/workflows/CI.yml`) builds on `node-version: 24`. The binding is Node-API (napi-rs v3), which is ABI-stable across Node majors. **[inferred from Node-API's stability guarantee for the specific 24.13 patch — CI pins the major, not the patch]** Note the published binding-test matrix is only Node 20 and 22; Node 24 is used for the build and lint jobs.
- **README support matrix says node16/18/20.** Stale relative to CI; treat CI as authoritative. **[measured-here]**

**Conclusion: the map's toolchain constraint is not the blocker.** Node 24.13 / npm 11.6 with no Python, .NET or Rust installs this cleanly. The blocker is §1.

---

## 8. The yellow border

**A `node-screenshots` capture draws no border at all.** **[verified-from-artifact]** The Windows 11 22H2+ capture indicator is a property of a `GraphicsCaptureSession`; there is no WGC session here, and no WinRT code in the binary (§1.4) to create one. `PrintWindow`/`BitBlt` predate the feature and `window-capture.md` §7 already established they do not trigger it.

**This is a loss, not a win, and it should be argued explicitly.** #2 and [#10](https://github.com/jpka/screen-solver/issues/10) noted the border was doubling as a free, OS-drawn, unspoofable "this window is being watched" indicator — one that visibly scopes the watching to *one window*, which supports the app's own privacy stance. Dropping to GDI removes it silently. If capture moves off WGC, the app must draw its own indicator, and that indicator is app-drawn and therefore inherently less trustworthy than the OS's.

**Can a direct WGC session suppress it?** No, not for an unpackaged app — and current `xcap` demonstrates the trap. `xcap` 0.9.8's WGC path calls `session.SetIsBorderRequired(false)` "best-effort" with the comment *"may fail … when the app lacks graphicsCaptureWithoutBorder capability."* But Microsoft's documented behaviour is worse than failing: *"If the user denies access, setting this property to **false** will succeed, but the value will be ignored and the border will be displayed during subsequent captures."* ([Microsoft Learn — `GraphicsCaptureSession.IsBorderRequired`](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired)) Suppression additionally requires `GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless)` **and** a `graphicsCaptureWithoutBorder` declaration in the **app's package manifest**. The doc also notes the border reappears if *any other app* sets `IsBorderRequired = true` for the same window.

So: **[inferred from that doc]** the border cannot be suppressed silently from an unpackaged Win32/Electron app, `xcap`'s "best-effort" call will appear to succeed while doing nothing, and `window-capture.md` §7's conclusion stands unchanged — plan for the border as permanent on any WGC path. Which makes the GDI path's border-free-ness a *behavioural difference to disclose to users*, not a feature to quietly enjoy.

---

## 9. Cost per capture, output format, licence

**Per-frame overhead: [unresolvable here]** — no Windows machine, and the repository's own `benchmark/bench.ts` is an empty stub (it constructs a `tinybench` `Bench` and prints an empty table; there are no registered cases). **[measured-here]** No published figures were found.

**What the code says the cost is made of** (each item verified from source; none quantified):
1. `PrintWindow` is documented **blocking and synchronous**: *"this is a blocking or synchronous function and might not return immediately … Calling this function from a thread that manages interaction with the user interface could make the application appear to be unresponsive."* ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)) It forces the *target application* to re-render its full content into the DC — cost is paid partly by Chrome, on every tick.
2. `PW_RENDERFULLCONTENT` specifically *"can adversely affect performance"* (Mozilla's finding, [Bug 1585619](https://bugzilla.mozilla.org/show_bug.cgi?id=1585619); their implementation produced a 10-second-startup-hang regression).
3. `GetDIBits` copies the whole bitmap to CPU memory, then `bgra_to_rgba` swaps two bytes per pixel across the entire buffer in a Rust loop.
4. `DynamicImage::crop` (0.4.1) — or a full CatmullRom `resize` in 0.9.8 — then a PNG/JPEG encode, all CPU-side.

**Mitigation already present:** `captureImage()` (async) is a napi `AsyncTask`, so the whole chain runs on the libuv threadpool and the Node event loop is not blocked — important given (1). `captureImageSync()` blocks the main thread and should not be used on a timer. **[verified-from-artifact]** ([`node-screenshots/src/async_capture.rs`](https://github.com/nashaofu/node-screenshots/blob/master/src/async_capture.rs))

**Settling test:** on the target machine, `console.time` around 100 sequential `await window.captureImage()` calls on a 1920×1080 Chrome window, then again with `.toPng()` included, then again with a video playing. Report p50/p95 separately — the interesting number is the tail, since `PrintWindow` blocks on Chrome's own render.

**Output format:** `Image` with `width`/`height` and `toPngSync/toPng`, `toJpegSync/toJpeg`, `toBmpSync/toBmp`, `toRawSync/toRaw` (RGBA), plus `cropSync/crop`. Each accepts a `copyOutputData` flag which the README says must be passed under Electron *"otherwise electron will crash"* ([napi-rs#1346](https://github.com/napi-rs/napi-rs/issues/1346)) — irrelevant if Electron is dropped, worth knowing if both coexist during a transition.

**Licence: Apache-2.0** for both `node-screenshots` (`package.json` + bundled `LICENSE`) and `xcap` (all versions on crates.io). **[verified-from-artifact]** Permissive, patent grant included, notice-preservation obligation only. Compatible with commercial distribution; adds an attribution line to whatever [#10](https://github.com/jpka/screen-solver/issues/10) produces.

**Test coverage, as a maturity signal.** `node-screenshots`' entire window test suite is:

```ts
test('Window.all()', (t) => {
  let windows = Window.all()
  t.true(windows.length >= 0)
})
```

That assertion is vacuously true. **There is no test that window capture returns an image at all**, let alone a non-black one — even though `Image` and `Monitor` do have capture tests. **[verified-from-artifact]** A black-frame regression on Windows would pass CI.

---

## 10. Alternatives in plain Node

| Option | Reaches WGC? | Install needs a compiler? | Verdict |
|---|---|---|---|
| **Electron `desktopCapturer`** | Yes, transitively via Chromium's `WgcCapturerWin` | No | Incumbent. Still the only mature no-compiler WGC path. |
| **`node-screenshots`** | **No — `PrintWindow`/`BitBlt`** | No | The subject of this document. See BLUF. |
| **`node-native-win-utils`** | **Yes — genuinely** | **On x64 no; on arm64/ia32 yes** | See below. |
| **`screenshot-desktop`** | No | Yes, at *runtime* | Disqualified. See below. |
| **`node-screenshots` monitor-capture + crop** | No, but sidesteps the black frame | No | Technically viable, reintroduces #2's privacy objection. See below. |
| **`@nodert-win10-20h1/windows.graphics.capture`** | Yes in principle | No | Unmaintained ~6 years (`window-capture.md` §6). Unchanged. |

### `node-native-win-utils` — the only real WGC-in-plain-Node candidate found
[npm](https://www.npmjs.com/package/node-native-win-utils) · v2.2.3, 2026-03-10 · MIT. Its `src/cpp/screenshot.cpp` is real WGC: `D3D11CreateDevice`, `CreateDirect3D11DeviceFromDXGIDevice`, `Direct3D11CaptureFramePool::Create`, `get_activation_factory<GraphicsCaptureItem>()`, `IGraphicsCaptureItemInterop->CreateForWindow(hwndTarget, …)`, then `Map` to CPU. It exports `captureWindowN` and `getWindowData`. **[verified-from-artifact]**

Four reasons not to reach for it:
1. **`"install": "node-gyp-build"`** with `prebuilds/` containing **only `win32-x64`**. On `win32-arm64` or `ia32`, `node-gyp-build` falls through to a `node-gyp` compile — MSVC Build Tools + Python. That is a direct violation of the domain constraint on any non-x64 target.
2. **9.0 MB of prebuilds**, of which 6.4 MB is `tesseract.dll` + `tiff.dll`. It bundles OCR and OpenCV.
3. **It is a Windows-automation grab bag, not a capture library.** Its exports include `setKeyDownCallback`/`setKeyUpCallback` (global keyboard hooks), `typeString`, `pressKey`, `mouseMove`, `mouseClick`, `mouseDrag`. Shipping a global keylogger-capable native module inside a screenshot app is a materially worse security and AV-heuristics story than shipping Electron — relevant to [#10](https://github.com/jpka/screen-solver/issues/10).
4. No `IsBorderRequired` call anywhere, so the yellow border applies with none of §8's escape hatches.

### `screenshot-desktop` — disqualified twice over
**[verified-from-artifact]** On Windows it copies a bundled `screenCapture_1.3.2.bat` into `%TEMP%`, then that batch file **searches `%SystemRoot%\Microsoft.NET\Framework\` for `csc.exe` and compiles embedded C# into a fresh `.exe` at runtime**:

```bat
for /r "%SystemRoot%\Microsoft.NET\Framework\" %%# in ("*csc.exe") do  set "csc=%%#"
if not exist "%csc%" ( echo no .net framework installed & exit /b 10 )
call %csc% /nologo /r:"Microsoft.VisualBasic.dll" /win32manifest:"app.manifest" /out:"%~n0.exe" "%~dpsfnx0"
```

That is a hard fail on the "no .NET" constraint, and "write a compiler-generated `.exe` into the temp directory and run it" is close to a textbook EDR detection. It is also **display-only** — the public API is `screenshot()`, `screenshot.all()`, `screenshot.listDisplays()`; there is no window capture.

### Monitor-capture + crop, using `node-screenshots` itself
Worth naming because it is a *free* fallback if the §2.1 spike comes back black. `xcap`'s `capture_monitor` is `BitBlt(SRCCOPY)` from `GetWindowDC(GetDesktopWindow())` — sampling the **desktop** DC, which contains DWM's composited output, **not** the per-window DC. **[inferred from the API distinction]** the GPU black-frame problem is specific to window DCs and `PrintWindow`; screen-level `BitBlt` is what ordinary screenshot tools use and it shows Chrome fine. So `Monitor.captureImage()` then `Image.crop(win.x(), win.y(), win.width(), win.height())` would produce real Chrome pixels through the same no-compiler package.

The cost is exactly the objection `window-capture.md` §1 raised against desktop-duplication-plus-crop, and it is a **product-level** objection, not a technical one: you decode the entire screen every tick when the app's stated privacy position is that full-screen capture is unacceptable, and anything overlapping the target window bleeds into the crop. Keep it in the back pocket as a degraded mode, do not design for it.

---

## 11. What this means for the runtime decision

**Electron cannot be dropped for capture on the strength of `node-screenshots`.** The single fact that decides it: the package that would replace `desktopCapturer` is built on `xcap` 0.4.1, whose window capture is `PrintWindow` with the undocumented `PW_RENDERFULLCONTENT` flag, and whose shipped binary contains no WinRT, D3D11 or DXGI code at all. That is the exact backend [#2](https://github.com/jpka/screen-solver/issues/2) chose Electron to avoid, reached by the exact undocumented workaround #2 called best-effort. Swapping to it does not trade a heavy dependency for a light one — it trades a *supported, compositor-native* capture path for an *unsupported, app-cooperation-dependent* one, against the single application class most likely to break it.

Three aggravating factors turn "risky" into "don't":

1. **Failure is silent.** `PrintWindow` reports success for a black bitmap (§2.2), so `xcap`'s own fallback chain never fires and no exception reaches JS. Every safety net would have to be written by this project — a per-frame pixel-ratio check before spending a vision-LLM call (#9, #13).
2. **Upstream has no regression coverage for it.** The entire window test suite asserts `windows.length >= 0` (§9). A black-frame regression ships green.
3. **The maintainer has already moved on.** `xcap` added a full WGC implementation in v0.8.3 (2026-03-01) and made it mutually exclusive with GDI. `node-screenshots` is pinned four minor series behind it and has not been touched since 2026-02-07.

What the research *does* clear: the toolchain fear was unfounded. Prebuilt `win32-x64` and `win32-arm64` binaries ship, there are no install scripts, no `node-gyp`, and no download step (§7). If a WGC-backed binding existed, Node 24.13 / npm 11.6 with no Python, .NET or Rust would install it cleanly. **The constraint that blocked this is the backend, not the build.** That is worth recording, because it means the domain note "no Rust" should not be read as "no native addons" — it rules out *compiling* Rust on the target, not *consuming* a Rust-built binary.

### What would have to be true for this to flip

Ordered by how much of the answer each one moves.

- **Someone builds `xcap >= 0.8.3` with `features = ["wgc"]` behind a napi binding and publishes prebuilt Windows binaries.** This is the real lever, and it is available today without waiting for anyone: fork `node-screenshots`, bump the `xcap` dependency, enable the feature, run the existing napi-rs CI. **Rust would be needed once, on a build machine, never on the target** — which satisfies the domain constraint as literally written. The costs are real and should be priced before committing: you own a native build/publish pipeline, you ship an unsigned self-built binary into whatever [#10](https://github.com/jpka/screen-solver/issues/10) produces (SmartScreen and AV heuristics both care), you inherit `xcap`'s five-month-old WGC path including whatever follows PRs #265 and #278, and you get the yellow border back with no way to suppress it (§8). Weigh that against what dropping Electron actually saves — which, now that the UI is a browser client, is bundle size and update surface, not architecture.
- **The §2.1 spike comes back with real pixels on Chrome across GPU vendors, including video and WebGL.** This would downgrade the objection from "wrong backend" to "undocumented backend that happens to work". It would *not* remove the need for a black-frame detector (§2.2), and it would still rest on a flag Microsoft does not document and does not guarantee across Chromium versions. Treat a green spike as permission to prototype, never as permission to ship without the detector.
- **`node-screenshots` upstream bumps its `xcap` pin and enables `wgc`.** Would resolve this cleanly, but nothing suggests it is coming: the binding has been static since 2026-02-07, and `wgc` is an undocumented opt-in feature that appears in no README, no CI job and no release note (§1.5). Do not plan around it.
- **The target content turns out to be text-only.** If the pages being solved never contain hardware-decoded video, WebGL or accelerated canvas, §2.3's expected failure profile mostly evaporates. This is the cheapest thing to check and it is a product question, not an engineering one — answer it before spending time on the spike.
- **A maintained, prebuilt, WGC-only Node addon appears** that is not a Windows-automation grab bag. `node-native-win-utils` proves the approach works in ~200 lines of C++ (§10); it is disqualified for what it bundles alongside, not for how it captures.

Until at least the first or second of those is true, **capture stays on Electron**, and the parts of this research that transfer regardless of backend are: gate every capture on `isMinimized()`; treat "window vanished from enumeration" as ambiguous between closed and moved-to-another-desktop (§5); expect variable pixel dimensions across monitors (§6); and add a non-black-pixel-ratio check before spending an LLM call, because it is cheap insurance that costs nothing if capture is working (§2.2).
