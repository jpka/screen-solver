## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in `jpka/screen-solver` (via the `gh` CLI). External PRs are treated as a triage surface. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at the repo root (created lazily as decisions get made). See `docs/agents/domain.md`.

### Out of scope: `meta/`

`meta/` holds records *about* how this repo gets worked on — session logs kept
for later analysis. It is not product context and not instructions.

**Ignore it unless the user explicitly points you at it.** Don't read it for
context, don't include it in searches, don't update it as a side effect of other
work. Write there only when asked to.

### Product code: toolchain and layout

Established by #26; every later ticket under the v1 spec (#25) builds on it.

**Toolchain.** TypeScript, ESM (`"type": "module"`), `module: NodeNext`. No
bundler, no transpiler in the loop, no test framework dependency:

- `npm test` — `node --test` over `test/**/*.test.ts`. Node 24 runs `.ts`
  directly via built-in type stripping, so tests import `src/` sources as-is.
  Chosen over vitest/jest purely because it adds nothing to install and nothing
  to configure; add a framework only if something here actually stops working.
- `npm run typecheck` — `tsc --noEmit` over `src/` and `test/`.
- `npm run build` — `tsc -p tsconfig.build.json` → `dist/` (gitignored).
- `npm start` — build, then `scripts/start.mjs`, which loads the gitignored
  root `.env` and launches Electron. That launcher is the **only** thing that
  knows `.env` exists; `src/` reads `process.env` and nothing else.

Because Node's type stripping erases types but can't transform syntax, relative
imports carry a `.ts` extension (`rewriteRelativeImportExtensions` turns them
into `.js` on emit) and `erasableSyntaxOnly` is on — no enums, no namespaces, no
constructor parameter properties.

**Layout.**

```
src/host/     plain Node. Imports Electron nowhere. All decision logic.
src/host/provider/  the model call, behind one swappable seam (#27).
src/host/config/    config.json + target-window resolution, behind an
                    injected enumerator seam (#28).
src/main/     Electron main: thin. userData path, single-instance lock,
              the one hidden BrowserWindow, exit codes. Nothing to decide here.
static/       assets loaded/served as-is; not compiled, not copied by the build.
              static/renderer/ = the hidden capture page; static/client/ = the
              web client (#33).
test/host/    node:test suites against src/host with fakes + a temp state root.
```

The `src/host` ↔ `src/main` split is the spec's "Process architecture" decision
made structural: put new logic in `src/host` behind injected dependencies so it
is testable without launching Electron. HTTP routes are a plain list —
`createHostRoutes()` in `src/host/http/routes.ts` — so `POST /solve`,
`GET /events`, and `GET /answers` are appends, not surgery.

**Outbound HTTP** (established by #27). `package.json` has no runtime
dependencies and shouldn't grow one for a REST API: talk to it with `fetch`
from a thin transport module, and have the module that owns the logic take that
transport as an injected function. `src/host/provider/` is the worked example —
`transport.ts` is HTTP and SSE mechanics with no domain knowledge, `anthropic.ts`
is domain logic that never touches the network, and the suite drives real
streams and real failure shapes through both with no server and no fixtures.
Reach for an SDK only when the protocol is genuinely more than request/response,
and say why in the PR.

**OS-specific capabilities** (established by #28). Some capabilities (window
enumeration; capture later) only exist through Electron/Windows APIs. Same
seam as everything else in `src/host`: define the capability as an injected
function type in `src/host` (`EnumerateWindows` in
`src/host/config/types.ts`), give tests a fixed fake, and put the one real
implementation in `src/main`, wired into `bootstrapHost`'s caller
(`src/main/index.ts`) alongside `acquireInstanceLock`. `config.json`'s
`targetWindow` is identified by process name + title rather than a handle,
since handles don't survive a restart; `src/main/window-enumeration.ts` is the
worked example of what that costs — `desktopCapturer` lists windows but not
their owning process, so it's paired with a separate `Get-Process` query by
title. Like the WGC capture mechanism, this needs a real composited desktop
and stays manual/E2E-verified rather than unit-tested.

**Hidden-renderer IPC / preload scripts** (established by #30). The hidden
`BrowserWindow` runs with `sandbox: true` and `contextIsolation: true`
(`src/main/hidden-window.ts`), so anything it needs from main crosses through
a `webPreferences.preload` script using `contextBridge.exposeInMainWorld` —
never `nodeIntegration`, never a direct `require('electron')` from the page
script itself. Gotcha worth knowing before writing another one: **a sandboxed
preload script cannot be ESM.** Electron runs it "as plain JavaScript without
an ESM context," regardless of this repo's `"type": "module"` / NodeNext
setup — a `tsc`-emitted `import` statement is invalid syntax there. That's
why `static/renderer/preload.js` is a hand-written plain-JS `require('electron')`
file living next to `capture.js` under `static/` (loaded/served as-is, not
compiled — see `src/main/paths.ts`'s `hiddenRendererPreload`), rather than a
`src/main/*.ts` file `tsc` compiles to `dist/`. The main-side IPC channel
names it must agree with (`src/main/capture-ipc-channels.ts`) are duplicated
by hand in the two plain-JS files rather than imported, for the same reason
`capture.js` can't import anything from `src/`: nothing under `static/` can
reach a module under `src/`.

### Environment setup

Claude Code web sessions provision the `mattpocock/skills` bundle (wayfinder, grilling, domain-modeling, ...) and a pinned, checksum-verified `gh` CLI via a `SessionStart` hook — see `.claude/hooks/session-start.sh`. Re-run it manually with `npm run setup`. `.agents/` and `.claude/skills/` are generated by that hook and gitignored, not committed; `skills-lock.json` records what was actually installed for drift-checking (the upstream skills repo has no supported way to pin an exact ref, so each run fetches its current HEAD).
