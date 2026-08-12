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

**Solve loop, SSE broadcast, and the internal outcome bus** (established by
#29). `src/host/solve/` wires the pre-flight guards (#30's `checkTargetStatus`
+ `CaptureSessionCoordinator.captureFrame()`) and the provider seam (#27)
behind one `SolveLoop.trigger()`, called from `POST /solve`
(`src/host/http/routes.ts`) before that handler responds. Two shapes worth
reusing:

- **`EventBroadcaster`** (`solve/broadcaster.ts`) is the SSE pattern: one
  `Set<ServerResponse>` of subscribed clients, one `broadcast()` writing the
  same `event: <type>\ndata: <json>\n\n` frame to all of them — no
  per-client filtering, per the spec. `GET /events`'s handler does nothing
  but call `subscribe(res)` and unregister on the request's `close`; this is
  the concrete shape `router.ts`'s "handlers get the raw `res`, so a
  streaming endpoint can hijack it... without fighting the router" comment
  was anticipating. It also holds the in-flight accumulated answer text in
  memory (`currentText()`), which `subscribe()` reads to send a late-joining
  client `sync{text}` instead of nothing when a solve is already in flight
  (#31) — a flag (set on `start()`, cleared on `done()`/`error()`) is the
  only extra state this needed.
- **The internal outcome bus** (`solve/types.ts`'s `SolveOutcome`,
  `SolveLoopDeps.onOutcome`) is a small explicit union —
  `done`/`interrupted`/`error`, each carrying the accumulated text — reported
  once per solve attempt that actually reached the provider. It is
  deliberately *not* on the SSE wire: the wire vocabulary has no
  `interrupted` kind, since an interruption's only wire-visible effect is
  "the old stream stops advancing and a fresh `start` begins immediately".
  Same "small union over a class" style as `ConfigChangeEvent` and
  `SolveEvent`. `onOutcome` itself is wrapped at the call site into
  `SolveOutcomeEvent { outcome, target, model }` rather than adding those two
  fields to every union variant — #31's persistence layer is the one real
  consumer, and needs `target`/`model` regardless of which variant it got.

A pre-flight guard failure (vanished/minimized target, black/zero-size
frame) never touches either of these — no broadcast, no outcome, no provider
call — which is the structural way "silent no-spend" is enforced: the code
simply has no event to emit for that path, rather than a flag suppressing one.

**Durable JSONL logs** (established by #31). `src/host/logs/jsonl.ts`'s
`openJsonlFile<T>({ path })` is the reusable half of `answers.jsonl` /
`usage.jsonl`: one JSON object per `\n`-terminated line, `append()` via
`fs.appendFile`'s OS append mode (`'a'` flag — concurrent appends from this
process don't clobber each other), `readAll()` re-reading the file fresh
every call rather than keeping an in-memory cache in sync (`GET /answers`'s
own requirement). `answer-log.ts`/`usage-log.ts` are both a fixed filename
plus an entry type wrapped around it; a future status log (#32) is expected
to be a third instance of exactly this shape rather than its own mechanism.
`logs/recorder.ts`'s `createSolveLogRecorder` is the one thing that isn't
generic: it subscribes to the outcome bus above and decides, per outcome,
which of the two logs get a line (a bail or an `error` never reaches
`answers.jsonl`; every attempted call reaches `usage.jsonl`) — and
serializes its own writes through an internal promise chain, since
interrupt-and-replace means two outcomes can genuinely be in flight at once,
and unserialized concurrent `fs.appendFile` calls race on disk-completion
order rather than preserving call order.

**Standing status pill** (established by #32; corrects this section's own
earlier guess that it would land as a third JSONL log -- it didn't. Nothing
in the spec or #32's acceptance criteria asks for a persisted status
history, only a live signal and one console line, so it stays in-memory
like `EventBroadcaster`'s own accumulated text, not a fourth file under the
state root). Two new pieces, both consumed from `solve/loop.ts`:

- **`solve/status.ts`**'s `StatusTracker` is the escalation ladder itself
  (`silent → auto-recovering → sticky`) as a pure function of
  `SolveOutcome` — no I/O, no `EventBroadcaster` dependency, so the rules
  (`done` resolves anything standing, including `sticky`; `auth` always
  escalates straight to `sticky` and doesn't get displaced by a later
  `transient`/`refusal`; `interrupted` never moves it) are unit-tested in
  isolation. `onOutcome` returns `null` on no-op transitions (e.g. a second
  `auth` error while already `sticky`) specifically so the caller doesn't
  have to diff snapshots itself just to avoid a duplicate SSE frame or
  console line.
- **`EventBroadcaster`** gained a `status{level,kind}` SSE frame alongside
  `start`/`delta`/`done`/`error`/`sync` — the spec's "standing status
  indicator... over the existing SSE channel" (story 38) ruled out a
  separate endpoint. `subscribe()` replays the current non-`silent` status
  to a freshly-connecting client exactly the way it already replays
  `sync{text}` to one connecting mid-flight, so a client that opens during
  an ongoing problem learns about it immediately rather than only on the
  next failure.

`loop.ts` prints exactly one console line on the way *into* `sticky`
(`logger.error`) — the acceptance criterion's own wording — and one more on
the way back to `silent` (`logger.info`, not required but cheap and keeps
the console honest about recovery too).

**Mid-run target loss** (established by #32). `capture/intent.ts`'s
`TargetIntentTracker` (`'active' | 'paused'`) is the "deliberate pause vs
unexpected loss" flag the spec calls for; nothing calls `pause()` yet (no
client exists to ask for one — that's #33/#34's job), so production always
reads `'active'` today. `loop.ts`'s pre-flight guard consults it the moment
a target is found vanished: paused means ignored outright (the existing
silent no-spend, no different from any other guard failure); active means
exactly one extra `checkTargetStatus` re-check before concluding the target
is really gone and falling back to the picker via
`configStore.setTargetWindow(null)` — reusing #28's existing change
broadcast and #30's existing "close the session when the target clears"
reaction rather than inventing a second fallback mechanism. Renderer-crash
escalation (the taxonomy's third branch) is a separate, unrelated concern —
`capture/crash-restart-policy.ts` unit-tests the pure backoff/give-up ladder,
but wiring it to a real `render-process-gone` event and hidden-window
re-creation needs a real renderer process, so — like the WGC capture
mechanism and `minimized-check.ts`'s `IsIconic` call — it stays
manual/E2E-verified rather than unit-tested.

**Web client core** (established by #33; the client `pause()` breadcrumb
above is still open — nothing calls it yet). `static/client/` is plain
HTML/CSS/vanilla JS, no bundler, no framework, matching this repo's
no-runtime-dependency rule (`package.json` still has zero `dependencies`).
Three new pieces on the host side, all `src/host/http/routes.ts` appends
rather than surgery on `POST /solve`/`GET /events`/`GET /answers`:

- **`GET /config`** — `{ targetWindow }`, the one thing a client can't learn
  from `GET /events` alone: what the target is *right now*, before any
  `config` frame has ever been broadcast. Deliberately narrower than the
  full `ScreenSolverConfig` — `provider` stays unexposed since nothing
  through #33 writes it.
- **`GET /windows`** / **`POST /config/target`** — the picker's list and
  commit action, both thin wrappers over `ConfigStore.listWindows()` /
  `.setTargetWindow()`. The body parser (`router.ts`'s new `readJsonBody`)
  is the one genuinely new mechanism: unbuffered request bodies had no
  reader anywhere in this codebase before `POST /config/target` needed one.
  An empty body parses as `null` (clear the target) rather than rejecting,
  so a client doesn't have to send a literal `null` payload for the common
  "no body" case.
- **`config{target}` on the SSE wire** — `EventBroadcaster` gains a fourth
  broadcast method alongside `start`/`delta`/`done`/`error`/`sync`/`status`,
  and `createHostRoutes` subscribes it to `ConfigStore.onChange` whenever a
  `configStore` is supplied. This is the belated other half of #28's own
  `config{target}` — its doc comment used to say the event "already has its
  own home on `ConfigStore.onChange`... and isn't this broadcaster's job",
  written before any client existed to actually listen. Now one does, so a
  target change (a fresh pick, *or* #32's own mid-run fallback to `null`)
  reaches every open tab live instead of only being visible on reload. No
  catch-up replay on `subscribe()`, unlike `sync`/`status`: a freshly
  connecting client already gets the current target from a plain `GET
  /config`, so there's nothing "in flight" for a catch-up frame to backfill
  — see `broadcaster.ts`'s own doc comment on the `config` variant of
  `SseEvent`. This also changed two pre-existing tests'
  expectations (`solve-http.test.ts`'s vanished-target case,
  `failure-taxonomy.test.ts`'s mid-run-loss case): both used to assert "no
  SSE traffic at all" for the picker fallback, which was only ever true
  because nothing broadcast it yet — now it's a `config` frame, and the
  tests assert that instead.

**Static asset serving** (established by #33; nothing served files before
this). `http/static.ts`'s `createStaticRoutes({ dir })` reads every file
under a directory once at startup (recursive `readdir`, `withFileTypes` +
`recursive: true` — Node ≥20.12, well inside this repo's `>=24` floor) and
turns each into its own exact-match `GET` route serving the file from
memory, content-type keyed off the extension. Deliberately not a wildcard
"catch everything under this prefix" handler: `router.ts`'s own comment
("the v1 HTTP surface has no path parameters") stays true, since this still
registers one literal route per file rather than adding pattern matching to
the router itself. `index.html` also gets a second route at bare `/`, so
opening the server's own URL is the same as opening `/index.html`. Wired
into `bootstrap.ts` as an *optional* `runtime.clientStaticDir` — appended
after `createHostRoutes`'s own routes rather than folded into that function,
so the `runtime.routes` full-bypass escape hatch (existing tests that inject
routes directly) stays a bypass of static serving too, not partially
reintroduced behind it. `src/main/index.ts` passes `paths.ts`'s new
`webClientDir` (`static/client/`); tests that don't care about the web
client simply never set it, and get no static routes at all — the same
"safe default that does less" shape every other optional `HostRuntime` field
already has.

**Shutdown ordering** (established by #31, tightened across three rounds of
review). Anything that persists on its way out has to be drained by
`StartedHost.shutdown()` (`bootstrap.ts`) *before* the resources it depends on
are torn down, and the drain itself has to be bounded. The worked example is
the solve loop: `SolveLoop.stop()` aborts the in-flight attempt (rather than
politely waiting out a model that may keep talking for another minute),
awaits *every* attempt still unwinding (not only the most recently triggered
one -- see below), and latches the loop closed so `trigger()` returns `false`
— `POST /solve` answers `503 shutting_down` for the moment the server is
still listening but nothing is left to run the work. Then
`SolveLogRecorder.drain()` catches any write still queued behind those.
The whole phase races `SOLVE_DRAIN_TIMEOUT_MS`, because abort is cooperative:
a provider ignoring its signal, or a hung `fs.appendFile`, must not keep the
process alive after the user quit. Losing the last line is the lesser
failure, and it's logged when it happens. A future subsystem with the same
shape belongs in the same bounded phase, not in a second unbounded await
appended after it.

**Track every in-flight unit of work a shutdown must wait for, not just the
newest one.** `SolveLoop`'s internal state used to hold a single `attempt`
slot, overwritten on every `trigger()` -- correct for `settled()` (a test
convenience that only ever cares about the latest call) but wrong for
shutdown: a target change supersedes the previous attempt by aborting it, but
that old attempt keeps running until *it* notices the abort and unwinds,
which can still be in flight when a second change supersedes the new one too.
`stop()` awaiting only the newest slot could resolve while an older,
already-superseded attempt was mid-unwind and about to persist its own
`interrupted` outcome -- silently losing it, a failure `SolveLogRecorder.drain()`
can't catch either, since it only awaits writes already enqueued into its
chain, not ones a still-running attempt hasn't gotten to yet. Fixed by
tracking every triggered attempt in a `Set`, self-removing on settle, and
having `stop()` await the whole set. The general lesson for anything shaped
like "the latest one supersedes the previous one, and shutdown needs to
observe all of it": a single mutable slot naturally answers "what should
`trigger()` return next", but shutdown's question is "what is still
outstanding", and those are different questions once more than one thing can
be in flight at once.

The bound on `bootstrapHost`'s own promise isn't the end of the story in
Electron, though (`src/main/index.ts`, tightened in review): `settlesWithin`
giving up doesn't mean whatever it was waiting on actually stopped -- a
provider ignoring its `AbortSignal` can still hold a socket open past the
timeout. `before-quit`'s handler calls `event.preventDefault()` and only lets
Electron's own quit sequence resume via an explicit `app.exit()` once
`host.shutdown()` has settled (bound and all), so a leftover handle can't
silently keep the process alive after shutdown has already given up on it.

**Web client responsive layout** (established by #34, closing out #25's own
spec). `static/client/` gains two phone-oriented layouts picked by
orientation, swapping live with no reload -- nothing on the host side
changed, this is entirely `app.js`/`styles.css`/`index.html`.

- **Orientation is `innerWidth > innerHeight` directly, not a media query,
  with a 480px landscape floor.** Verified against `prototype/21-web-client`
  (#21's real-device prototyping, kept on that branch as prior art, not
  promoted to `main`): a compound `matchMedia` query is one more thing that
  can silently fail to match; a direct dimension comparison cannot.
  `matchMedia`/`resize`/`orientationchange` are kept only as change
  *triggers* that ask the comparison to re-run -- `orientationchange` in
  particular re-checks again a frame later and once more after a short
  delay, since Android fires it before the resize settles. The 480px floor
  (clearing every phone in landscape, iPhone SE included) exists so a narrow
  desktop window that happens to be taller-than-wide-adjacent doesn't get a
  rail it has no room for.
- **One `openEntryId`, not a per-layout pane mode.** Portrait
  (`app.js`'s `renderPortrait`) is a continuous log -- one feed, physical
  order fixed (newest/live first), whichever entry is "open" renders
  expanded and outlined, everything else collapses to a line, tapping a
  collapsed one opens it. Landscape (`renderLandscape`) is a 132px rail
  (every entry, collapsed, live pinned at top) beside a single detail pane
  holding whichever entry is open. Both layouts read the exact same
  `openEntryId`, which is deliberately why a rotation needs no explicit
  normalization step: the prototype's own writeup documented a "forced-
  variant trap" where its rail's separate `paneMode: 'history'` concept
  didn't survive being carried into the log layout unchanged (a live entry
  rendered with history's chrome). There is only ever one open entry here,
  full stop, so that mismatch has nowhere to live.
- **`liveEntry` vs. `historyEntries` is folded, not duplicated.** The `#33`
  client rendered "the current answer" and "history" as two independent
  views, so a completed answer showed up twice (once in each). `#34`
  collapses that: `liveEntry` is this session's current-or-just-finished
  attempt, always referenced by the sentinel id `'live'`; `demoteLiveEntry()`
  folds a *finished* (`state === 'done'`) one into `historyEntries` right
  before the next `start` claims the slot, using the same
  `completionIdentity`-keyed dedup queue #33 built for the snapshot-vs-stream
  race (a fold that happens before `GET /answers` resolves is queued and
  replayed after, filtered against what the snapshot already contains). A
  bail or an `error` is simply dropped at that point, matching what
  `logs/recorder.ts` would (not) persist -- there is nothing a reload would
  ever show for either.
- **The connection indicator collapses two signals onto one**, per the
  prototype's own settled finding: the SSE socket's own state
  (`connecting`/`connected`/`reconnecting`/`disconnected`, tracked off
  `EventSource`'s native `open`/`error` events and `readyState`) while
  `openEntryId === 'live'`, replaced wholesale by "Viewing history" the
  moment it isn't -- a history view has no use for "the live socket is
  fine underneath". A transient `syncing…` tag rides along, set on a `sync`
  catch-up frame and cleared the moment a real `delta` resumes (or anything
  else ends the window: `done`/`error`/a fresh `start`).
- **Fullscreen is feature-detected, not assumed.** `document.documentElement
  .requestFullscreen` (with the `webkit`-prefixed fallback) gates the
  button's `disabled` state and its `title` tooltip -- confirmed functional
  on Android Chrome by the same real-device prototyping; iPhone Safari has
  never exposed the Fullscreen API for arbitrary elements, so there the
  button renders visibly disabled with an explanation instead of failing
  silently on click. ("Add to Home Screen" + a `display: standalone`
  manifest is the prototype's noted alternate route for that case -- a
  different mechanism, not built here.)

Nothing here is unit-tested -- consistent with the ticket's own testing
decision, and with #28's `window-enumeration.ts` / #30's `minimized-check.ts`
precedent for "needs a real device/composited surface, stays manual/E2E-
verified": there is no browser test runner in this repo, and orientation
swap + fullscreen feature-detection both need a real (or at least a real
Chromium) viewport to mean anything. Verified instead by booting the real
HTTP surface (`createHostRoutes` + `createStaticRoutes`) against a temp
state root and a scripted fake `Provider`, then driving it through a real
Chromium viewport: the 480px floor's exact boundary (479px stays portrait,
480px flips to landscape), rotation preserving whichever entry was open in
both directions (live-open and history-open), the connection indicator's
live/history swap, `demoteLiveEntry`'s fold-on-next-`start` behavior, and
both the enabled and (via a feature-detection override, simulating iPhone
Safari) disabled fullscreen-button states.

**The spoken-only solve.** A third solve mode: the user asks a question out
loud and nothing is captured at all. `POST /solve/transcript-only` +
`static/client/`'s "Solve speech only" button, with four decisions worth
keeping:

- **`Provider.solve` takes `SolveImage | null`, and the absence of the image
  block is the whole signal.** No second system prompt, no flag in the body --
  `system-prompt.ts`'s own cache argument (one prompt, one 1-hour cached
  ~1400-token prefix, so alternating between buttons never pays a cache miss)
  applies with more force to a third mode than it did to the second. The prompt
  gained a "Speech only, no screenshot" section instead, and the rules that
  used to assume a screenshot always exists are now scoped to requests that
  carry one. `anthropic.ts` also refuses a call with neither image nor
  transcript rather than sending it: the model could only guess, and the guess
  would still be billed.
- **`SolveMode` is a closed union (`screen` / `screen-with-transcript` /
  `transcript-only`), not a pair of booleans.** "Include the transcript" plus
  "skip the screenshot" would make four combinations out of the three things
  this app does, and the fourth has no question in it. `runAttempt` branches
  once on a value it can exhaust; the committed half of an attempt (the
  provider call, the single `broadcaster.start()`, the one terminal outcome,
  the one `onOutcome`) is factored into `callProvider` so every mode shares it
  and none of those invariants can drift per-mode.
- **The spoken-only mode is blind to the target window, and the logs say so
  with `target: null`.** No frame is grabbed, so a vanished, minimized or
  entirely unconfigured window is irrelevant -- it is the one solve route that
  answers `202` before the picker has ever been used, which is exactly the
  case it exists for. `AnswerLogEntry.target` / `UsageLogEntry.target` /
  `SolveOutcomeEvent.target` are nullable rather than carrying whatever
  happened to be configured: recording a window for an attempt that never
  looked at one would be a claim no screenshot supports. Null rather than
  omitted, so it can't be confused with a line written before this mode
  existed.
- **A second bail marker, not a reused one.** `title.ts` gained
  `NO_QUESTION_TITLE` (`# No question in the recent speech`) for speech that
  asks nothing, because `# No exercise on screen` would be a false statement
  about a request that was shown no screen. `isBailTitle()` accepts either, so
  `recorder.ts`'s dispatch table needed no new branch -- both markers mean the
  same thing to the logs (a `usage.jsonl` line, no `answers.jsonl` line).
  `POST /solve/transcript-only` refuses `400 no_transcript` before spending a
  call when the window is empty, so that marker only ever comes back for
  speech that was genuinely captured and genuinely asked nothing.

The transcript window is rendered twice on that route -- once by the handler to
ask "is there anything to send?", once inside `trigger()` for the text that
actually travels. Deliberate: the second render is what keeps "the transcript
is what was being said when the button was pressed" true, and threading the
first one into the loop would trade that property for the appearance of
tidiness.

**The mock quiz** (`test/fixtures/mock-quiz/`). One fixed set of problems
covering the three ways a question reaches this app -- on the screen, out of
the speakers, or both at once -- read by an automated e2e suite
(`test/e2e/mock-quiz.e2e.test.ts`) and by a human at a real Windows machine
(`npm run mock-quiz` serves the rig). Its own `README.md` is the manual
procedure; what belongs here is the decisions behind it.

- **The quiz is `quiz.json`, not a `.ts` module.** The manual rig is a browser
  page, and nothing served to a browser in this repo can import from `src/` or
  `test/` -- the same constraint that put `static/renderer/preload.js` in
  hand-written plain JS. A TypeScript module holding the problems would have
  needed a second copy for the page to render, so the data is JSON, `fetch`ed
  by the page and `readFile`d by `quiz.ts`. `quiz.ts` is the typed *read* side
  only, and it validates rather than trusts: a problem whose kind, screen,
  speech and expected outcome don't line up is a thrown error, because the
  three-kind taxonomy is the entire point of the fixture and a quiz that
  silently lost one of them would still pass every assertion.
- **A voice-only problem has two right answers, and the fixture holds both.**
  Which one is correct depends on which button was pressed, so `expected` is
  what the problem's own route should produce and `expectedIfScreenSent` is
  what the screen-carrying button must produce instead. Pressed with "Solve
  speech only" a spoken question is genuinely answered; pressed with "Solve
  with transcript" the catalogue screenshot goes along with the speech and the
  screen is still authoritative, so `# No exercise on screen` remains the only
  correct answer. Before the spoken-only mode existed the bail was the *only*
  expectation these problems had -- keeping it as the second one is what stops
  the new capability from quietly eroding the older rule, which is the
  regression a quiz is for. (Each expectation carries its own
  `scriptedAnswer`, so the answer a fake provider streams in an automated run
  is still the answer a human grades a real model against.)
- **The rig never renders the spoken script.** A page that printed the question
  would turn a voice problem into a screen problem and quietly pass the test
  the app should fail, so the script lives in a crib sheet that is closed by
  default and warns that it is on screen while open. That was true when a voice
  problem could only bail and it is more load-bearing now that one can be
  answered: with the script visible, a "spoken-only" solve would be reading its
  own question off the screenshot it isn't sending.
- **The e2e harness grew the audio half rather than a second harness.**
  `bootApp` now wires fakes for `openAudioCapture` and `transcriber` at the
  same injection points production uses, and `E2EApp` gained the recording
  vocabulary (`startRecording`, `say`, `pushAudio`, `getTranscript`,
  `waitForTranscriptLines`) -- so speech enters an e2e run at the
  transcription seam, exactly where Deepgram would put it, and everything
  downstream is the real code path. They are wired unconditionally (a
  `recording: false` boot option exists for the "no key" state): an app whose
  recording toggle reports `'unavailable'` is a differently-configured app,
  and this harness's job is the fully assembled one. `ScriptedCall` also
  carries the whole `SolveOptions` now, not just `signal`, because the
  difference `POST /solve` promises is between "no transcript key" and "a
  transcript key that happens to be undefined", and only the raw object can be
  asked which one it is.

What the automated run does *not* prove is worth restating wherever this
fixture is used: the provider is faked, so `scriptedAnswer` is what the fake
streams and `expected.mustMention` is for a human grading a real run. The
suite covers the plumbing between the two buttons and the disk -- which route
carries speech, that a screenshot goes out on every solve, that the transcript
reaching the model is the speech actually captured, and that each problem
leaves the right pair of JSONL lines. Answer *quality* stays manual, the same
call `solve-journey.e2e.test.ts` already documents for the prompt contract.

### Environment setup

Claude Code web sessions provision the `mattpocock/skills` bundle (wayfinder, grilling, domain-modeling, ...) and a pinned, checksum-verified `gh` CLI via a `SessionStart` hook — see `.claude/hooks/session-start.sh`. Re-run it manually with `npm run setup`. `.agents/` and `.claude/skills/` are generated by that hook and gitignored, not committed; `skills-lock.json` records what was actually installed for drift-checking (the upstream skills repo has no supported way to pin an exact ref, so each run fetches its current HEAD).
