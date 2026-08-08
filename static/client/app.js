// Screen Solver web client (#33/#34) -- connect to the live stream, show
// history, trigger a solve, pick a target window, and lay all of that out
// for a phone: two layouts picked by orientation, swapping live with no
// reload and no lost state, plus fullscreen. Deliberately dependency-free
// (no bundler, no framework) per this repo's static/ convention -- see
// AGENTS.md's "Product code: toolchain and layout".
//
// Talks to the wire contract built by #28/#29/#31/#32/#33:
//   GET  /config          -> { targetWindow, revision }    (#33)
//   GET  /windows          -> WindowInfo[]                 (#33)
//   POST /config/target    -> { targetWindow, revision }   (#33)
//   GET  /answers          -> AnswerLogEntry[]              (#31)
//   POST /solve             -> 202/400/503                   (#29)
//   GET  /events (SSE)      -> start/delta/done/error/sync/status/config{,revision}

(() => {
  'use strict';

  // Mirrors `src/host/logs/title.ts`'s `BAIL_TITLE` -- the client has no
  // server-side module to import, so this is kept in lockstep by hand. Only
  // used to decide *display* emphasis; the server remains the sole authority
  // on what actually gets persisted.
  const BAIL_TITLE = 'No exercise on screen';

  const IDLE_TEXT = 'Click "Solve now" to analyze the target window.';

  // Verified on a real device against prototype/21-web-client (#21/#34's
  // prior art): every phone clears this in landscape (iPhone SE, the
  // narrowest in practice, is 568px), so the floor exists purely to stop a
  // narrow *desktop* window that happens to be taller-than-wide-adjacent
  // from getting a rail it has no room for.
  const LANDSCAPE_MIN_WIDTH = 480;

  const CONNECTION_LABELS = {
    connecting: 'Connecting…',
    connected: 'Live',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
  };

  const solveButton = document.getElementById('solve-button');
  const statusPill = document.getElementById('status-pill');
  const connectionIndicator = document.getElementById('connection-indicator');
  const fullscreenButton = document.getElementById('fullscreen-button');
  const picker = document.getElementById('picker');
  const pickerError = document.getElementById('picker-error');
  const windowList = document.getElementById('window-list');
  const refreshWindowsButton = document.getElementById('refresh-windows');
  const targetBar = document.getElementById('target-bar');
  const targetLabel = document.getElementById('target-label');
  const solveError = document.getElementById('solve-error');
  const entriesRoot = document.getElementById('entries-root');

  /** @type {{processName: string, title: string} | null} */
  let currentTarget = null;

  // ---------------------------------------------------------------------
  // Entry model.
  //
  // `liveEntry` is this browser session's current-or-just-finished attempt
  // (null until the first `start`/`sync` this session sees one); it is
  // always referenced by the sentinel id `'live'`, never a stable id of its
  // own, precisely so `openEntryId === 'live'` keeps tracking "whatever's
  // live" across a `start` that replaces it -- see `demoteLiveEntry` below.
  //
  // `historyEntries` is the persisted log: the `GET /answers` snapshot plus
  // anything `demoteLiveEntry` has folded in since, newest first, each
  // frozen with a stable `_id` the moment it's created.
  //
  // There is deliberately no separate "pane mode" per layout (live vs.
  // history) the way the rejected D-only prototype had -- both layouts
  // read the *same* `openEntryId`, which is why a rotation needs no explicit
  // normalization step to avoid the "forced-variant trap" writeup's
  // state-model mismatch (a live entry rendered with history's chrome):
  // there is only ever one open entry, full stop, and both layouts agree on
  // what it means.
  let liveEntry = null;
  let historyEntries = [];
  /** @type {'live' | string} */
  let openEntryId = 'live';

  // Startup snapshot-vs-stream ordering (Greptile review on #33's PR): the
  // initial `GET /config` and `GET /answers` fetches race the `GET /events`
  // SSE connection opening alongside them. A `config`/`done` frame can land
  // *before* its slower snapshot sibling resolves, and without guarding
  // against it the snapshot's `.then()` would overwrite (config) or wipe
  // (history) state a live frame had already applied -- silently reverting
  // to stale data with nothing to trigger a re-render.
  //
  // A first attempt at the config half latched "the live path always wins"
  // on a plain boolean -- wrong, because arrival order between two
  // independent connections (this fetch vs. the SSE socket) says nothing
  // about which one actually describes more current server state; a slow
  // `GET /config` response can easily describe a *later* change than an
  // SSE frame the client already applied. `latestConfigRevision` compares
  // `broadcaster.ts`'s own monotonic revision counter instead (present on
  // every `config` SSE frame, `GET /config`, and a `POST /config/target`
  // response), so whichever source reports the higher revision wins,
  // regardless of which happened to arrive first. `-1` sorts below every
  // real revision (`broadcaster.ts` starts counting at `1`), so the very
  // first thing to arrive -- through either path -- is always applied.
  let latestConfigRevision = -1;
  // History (in the #34 model, "folding a finished live entry in") has no
  // single "current value" to compare a revision against, so it uses a
  // queue instead: a fold that happens before `GET /answers` resolves is
  // held here and replayed *after* the snapshot renders, then filtered
  // against what the snapshot already contains -- the recorder's JSONL
  // write can complete before this client's own `GET /answers` does, so the
  // same answer can legitimately show up in both the snapshot and the queue.
  let historySnapshotLoaded = false;
  const queuedDemotedEntries = [];

  // Socket state (of the SSE connection itself) vs. `statusPill`'s
  // escalation ladder (#32, unrelated -- that one tracks provider-call
  // health, not the transport). Only meaningful while `openEntryId` is
  // `'live'`; see `renderConnectionIndicator`.
  let connectionState = 'connecting';
  // Transient "syncing…" tag for a `sync` catch-up window (#31's mid-flight
  // join/reconnect). Cleared the moment a real `delta` resumes, or on
  // anything that ends the window outright (`done`/`error`/a fresh `start`).
  let syncing = false;

  /** @type {'portrait' | 'landscape'} */
  let currentOrientation = computeOrientation();

  /**
   * Source of truth for orientation is a direct dimension comparison, not a
   * media query -- verified against prototype/21-web-client (#21/#34): a
   * compound `matchMedia` query is one more thing that can silently fail to
   * match, where `innerWidth`/`innerHeight` cannot. `matchMedia` is kept
   * below only as one of several *triggers* that ask this function to
   * re-run, never as the answer itself.
   */
  function computeOrientation() {
    const landscape = window.innerWidth > window.innerHeight && window.innerWidth >= LANDSCAPE_MIN_WIDTH;
    return landscape ? 'landscape' : 'portrait';
  }

  function parseAnswerTitle(text) {
    const match = /^#[ \t]+(.+)$/m.exec(text);
    return match ? match[1].trim() : null;
  }

  function formatTarget(target) {
    if (!target) return '';
    return `${target.title} — ${target.processName}`;
  }

  /** The single place that flips between the picker and the entry views. Reached only through {@link applyConfigIfNewer}, which all three sources of a target (an initial `GET /config`, a successful `POST /config/target`, a live `config` SSE frame) are funneled through, so this never has to arbitrate ordering itself. */
  function applyConfig(targetWindow) {
    currentTarget = targetWindow;
    solveButton.disabled = targetWindow === null;
    if (targetWindow === null) loadWindows();
    render();
  }

  /** Applies `targetWindow` only if `revision` is at least as new as the last one actually applied, updating the latch either way it's compared against next time. Shared by all three sources of a target (`GET /config`, `POST /config/target`, the `config` SSE frame) so they can't disagree about ordering. */
  function applyConfigIfNewer(targetWindow, revision) {
    if (revision < latestConfigRevision) return;
    latestConfigRevision = revision;
    applyConfig(targetWindow);
  }

  async function loadConfig() {
    try {
      const res = await fetch('/config');
      if (!res.ok) return;
      const body = await res.json();
      applyConfigIfNewer(body.targetWindow, body.revision);
    } catch {
      // Left on the initial "no target" default (picker shown, empty list);
      // `loadWindows()`'s own error path reports the underlying failure.
    }
  }

  async function loadWindows() {
    pickerError.hidden = true;
    windowList.innerHTML = '';
    try {
      const res = await fetch('/windows');
      if (!res.ok) throw new Error(`GET /windows -> ${res.status}`);
      const windows = await res.json();

      if (windows.length === 0) {
        windowList.appendChild(emptyHint('No open windows found. Try Refresh once something is open.'));
        return;
      }
      for (const win of windows) windowList.appendChild(renderWindowItem(win));
    } catch (err) {
      pickerError.hidden = false;
      pickerError.textContent = `Could not load the window list: ${err.message}`;
    }
  }

  function renderWindowItem(win) {
    const li = document.createElement('li');

    const info = document.createElement('div');
    info.className = 'window-info';
    const title = document.createElement('span');
    title.className = 'window-title';
    title.textContent = win.title;
    const process = document.createElement('span');
    process.className = 'window-process';
    process.textContent = win.processName;
    info.append(title, process);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Use this window';
    button.addEventListener('click', () => pickWindow(win));

    li.append(info, button);
    return li;
  }

  async function pickWindow(win) {
    pickerError.hidden = true;
    try {
      const res = await fetch('/config/target', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(win),
      });
      if (!res.ok) throw new Error(`POST /config/target -> ${res.status}`);
      const body = await res.json();
      // The `config` SSE frame will also arrive shortly and call this again
      // with the same revision -- `applyConfigIfNewer` is idempotent on a
      // repeated revision, so that's a harmless no-op re-render, not double
      // state.
      applyConfigIfNewer(body.targetWindow, body.revision);
    } catch (err) {
      pickerError.hidden = false;
      pickerError.textContent = `Could not set the target window: ${err.message}`;
    }
  }

  refreshWindowsButton.addEventListener('click', loadWindows);

  solveButton.addEventListener('click', async () => {
    solveError.hidden = true;
    solveButton.disabled = true;
    try {
      const res = await fetch('/solve', { method: 'POST' });
      if (res.status !== 202) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `unexpected status ${res.status}`);
      }
      // Left disabled -- `start` re-enables nothing until `done`/`error`
      // brings it back, since a second click mid-stream just interrupts the
      // first (the server allows it, but there's no reason to invite it from
      // the UI when the point of the button is "watch this one finish").
    } catch (err) {
      solveError.hidden = false;
      solveError.textContent = `Could not start a solve: ${err.message}`;
      solveButton.disabled = currentTarget === null;
    }
  });

  function badge(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  function emptyHint(text) {
    const li = document.createElement('li');
    li.className = 'empty-hint';
    li.textContent = text;
    return li;
  }

  /**
   * A completion's identity for de-duplicating a folded-in live entry
   * against the `GET /answers` snapshot (see {@link loadHistory}). The
   * server assigns no client-visible ID to a solve, so this is necessarily a
   * heuristic -- but `text` alone is too weak (review feedback on #33:
   * solving the same exercise twice in a row can legitimately produce
   * byte-identical output, which would make a real second answer look like a
   * duplicate of the first and get silently dropped). Folding in the target
   * identity and the *exact* token-usage tuple narrows this to "two
   * independent calls produced the same text *and* the same target *and*
   * the same four usage numbers" -- a provider call's real accounting
   * varies with things the client has no control over (retries, exact image
   * bytes, prompt-cache hits), so two genuinely different solves landing on
   * identical usage as well as identical text is not a realistic collision,
   * even though it remains possible in principle without a real ID from the
   * server.
   */
  function completionIdentity(entry) {
    const usage = entry.usage ?? {};
    return JSON.stringify([
      entry.text,
      entry.target?.processName,
      entry.target?.title,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationInputTokens,
      usage.cacheReadInputTokens,
    ]);
  }

  /**
   * Folds a finished `liveEntry` into `historyEntries` and clears the live
   * slot, called right before a new `start` claims it. Only a cleanly
   * finished attempt (`state === 'done'`) has a server-persisted counterpart
   * to fold in -- a bail or an `error` is never written to `answers.jsonl`
   * (`logs/recorder.ts`), and an attempt still `'streaming'` when a new
   * `start` interrupts it never got a `done` at all, so there is nothing a
   * reload would ever show for either. Both are simply dropped, matching
   * what the server itself would (not) persist.
   */
  function demoteLiveEntry() {
    if (!liveEntry) return;
    if (liveEntry.state === 'done') {
      const finished = { ...liveEntry, _id: completionIdentity(liveEntry) };
      if (historySnapshotLoaded) historyEntries.unshift(finished);
      else queuedDemotedEntries.push(finished);
    }
    liveEntry = null;
    // `openEntryId` is left untouched: if it was `'live'`, it now naturally
    // refers to whatever `start` sets up next (the whole point of the
    // sentinel); if it was pointing at some other history entry, that
    // entry's `_id` is unaffected by this fold.
  }

  async function loadHistory() {
    let snapshot = [];
    try {
      const res = await fetch('/answers');
      if (res.ok) snapshot = await res.json();
    } catch {
      // Best-effort: a failed load just leaves history empty rather than
      // blocking the rest of the page -- the code below still runs
      // regardless, so anything queued by `demoteLiveEntry` is not lost
      // either way, just replayed on top of an empty-ish snapshot.
    }

    // Snapshot arrives oldest-first; `historyEntries` is newest-first.
    historyEntries = snapshot
      .slice()
      .reverse()
      .map((entry) => ({ ...entry, _id: completionIdentity(entry) }));

    // Whether the fetch succeeded or not, the snapshot phase is over -- any
    // fold that happened while it was in flight was queued rather than
    // spliced in directly (it would have been wiped by the assignment
    // above). Replay it now, on top of what the snapshot just produced --
    // except when the recorder's JSONL write already landed before this
    // fetch ran, in which case the snapshot above already contains it and
    // replaying would duplicate the row. See `completionIdentity` for what
    // "already contains it" is judged by, and why.
    historySnapshotLoaded = true;
    const alreadyPersisted = new Set(historyEntries.map((e) => e._id));
    for (const queued of queuedDemotedEntries) {
      if (!alreadyPersisted.has(queued._id)) historyEntries.unshift(queued);
    }
    queuedDemotedEntries.length = 0;

    render();
  }

  function setStatusPill(level, kind) {
    if (level === 'silent') {
      statusPill.hidden = true;
      return;
    }
    statusPill.hidden = false;
    statusPill.dataset.level = level;
    statusPill.textContent = level === 'sticky' ? `Needs attention (${kind})` : `Recovering (${kind})`;
  }

  // -----------------------------------------------------------------------
  // Fullscreen (#34). Feature-detected per platform, per prototype/
  // 21-web-client's confirmed finding: functional on Android Chrome via the
  // standard Fullscreen API (with the `webkit`-prefixed fallback some
  // browsers still need); iPhone Safari has never exposed the Fullscreen API
  // for arbitrary elements, so there the button renders visibly disabled
  // (native `disabled`, plus an explanatory `title`) instead of failing
  // silently on click. (The prototype's noted alternative for that case --
  // "Add to Home Screen" + a `display: standalone` manifest -- is a
  // different mechanism entirely and out of scope here.)
  const fullscreenTarget = document.documentElement;

  function fullscreenSupported() {
    return !!(fullscreenTarget.requestFullscreen || fullscreenTarget.webkitRequestFullscreen);
  }

  function isFullscreenActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    if (!fullscreenSupported()) return;
    if (isFullscreenActive()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      (fullscreenTarget.requestFullscreen || fullscreenTarget.webkitRequestFullscreen).call(fullscreenTarget);
    }
  }

  function renderFullscreenButton() {
    const supported = fullscreenSupported();
    fullscreenButton.disabled = !supported;
    fullscreenButton.textContent = isFullscreenActive() ? '⤢' : '⛶';
    fullscreenButton.title = supported
      ? isFullscreenActive()
        ? 'Exit fullscreen'
        : 'Fullscreen'
      : 'Fullscreen not supported by this browser (e.g. iPhone Safari has no Fullscreen API for arbitrary elements)';
  }

  fullscreenButton.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', renderFullscreenButton);
  document.addEventListener('webkitfullscreenchange', renderFullscreenButton);

  // -----------------------------------------------------------------------
  // Connection indicator (#34). Two independent signals collapsed onto one:
  // the SSE socket's own state while the open entry is the live one, wholly
  // replaced by "viewing history" while it isn't -- a history view has no
  // use for "the socket underneath is fine", per prototype/21-web-client's
  // finding that showing both is just noise.
  function renderConnectionIndicator() {
    const isLiveOpen = openEntryId === 'live';
    connectionIndicator.dataset.state = isLiveOpen ? connectionState : 'history';
    if (!isLiveOpen) {
      connectionIndicator.textContent = 'Viewing history';
      return;
    }
    const label = CONNECTION_LABELS[connectionState] ?? connectionState;
    connectionIndicator.textContent = syncing ? `${label} · syncing…` : label;
  }

  // -----------------------------------------------------------------------
  // Rendering. Full rebuild of whichever layout is current, driven by the
  // orientation/entry/connection state above -- no framework, so this is a
  // plain "throw away the DOM under the mount point and rebuild" pass, kept
  // cheap by the small size of what's rendered. Scroll position inside the
  // split-rail layout's two independently-scrolling regions is preserved
  // across a rebuild explicitly (see `captureScrollPositions`); the
  // continuous log has no inner scroll region -- it's the page itself that
  // scrolls -- so there's nothing to preserve there.

  function displayList() {
    const live = liveEntry
      ? { ...liveEntry, id: 'live', isLive: true }
      : { id: 'live', isLive: true, title: null, text: IDLE_TEXT, state: 'idle' };
    const history = historyEntries.map((entry) => ({ ...entry, id: entry._id, isLive: false }));
    return [live, ...history];
  }

  function captureScrollPositions() {
    const positions = {};
    entriesRoot.querySelectorAll('[data-scroll-key]').forEach((el) => {
      positions[el.dataset.scrollKey] = el.scrollTop;
    });
    return positions;
  }

  function restoreScrollPositions(positions) {
    entriesRoot.querySelectorAll('[data-scroll-key]').forEach((el) => {
      if (el.dataset.scrollKey in positions) el.scrollTop = positions[el.dataset.scrollKey];
    });
  }

  function buildCardHeader(entry) {
    const header = document.createElement('div');
    header.className = 'entry-card-header';

    const title = document.createElement('div');
    title.className = 'entry-title';
    title.textContent = entry.title || (entry.isLive ? 'Current answer' : '(untitled)');
    if (entry.isLive && entry.state === 'bail') title.appendChild(badge('bail-badge', ' no exercise'));
    if (!entry.isLive && entry.title === BAIL_TITLE) title.appendChild(badge('bail-badge', ' no exercise'));
    if (entry.interrupted) title.appendChild(badge('interrupted-badge', ' interrupted'));
    header.appendChild(title);

    if (!entry.isLive || entry.state === 'done' || entry.state === 'bail' || entry.state === 'error') {
      const meta = document.createElement('div');
      meta.className = 'entry-meta';
      const when = entry.timestamp ? new Date(entry.timestamp) : null;
      const usageText =
        entry.usage && (entry.usage.inputTokens || entry.usage.outputTokens)
          ? `${entry.usage.inputTokens} in / ${entry.usage.outputTokens} out`
          : '';
      meta.textContent = [when ? when.toLocaleString() : '', entry.model, formatTarget(entry.target), usageText]
        .filter(Boolean)
        .join(' · ');
      if (meta.textContent) header.appendChild(meta);
    }

    return header;
  }

  function buildCardBody(entry) {
    const pre = document.createElement('pre');
    pre.className = 'entry-card-text';
    pre.dataset.state = entry.state;
    pre.textContent = entry.text;
    return pre;
  }

  function attachOpenHandler(el, id) {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', () => {
      openEntryId = id;
      render();
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openEntryId = id;
        render();
      }
    });
  }

  /** Portrait: a continuous log, one feed. Physical order never changes with
   * which entry is open (the live slot is always first) -- only which entry
   * renders expanded-and-outlined vs. collapsed-to-a-line does. */
  function renderPortrait() {
    entriesRoot.dataset.layout = 'portrait';
    entriesRoot.innerHTML = '';

    const feed = document.createElement('ul');
    feed.className = 'entry-feed';

    for (const entry of displayList()) {
      const isOpen = entry.id === openEntryId;
      const li = document.createElement('li');
      li.className = 'entry-card' + (isOpen ? ' entry-card--open' : ' entry-card--collapsed');
      if (entry.isLive) li.classList.add('entry-card--live');
      if (entry.interrupted) li.dataset.interrupted = 'true';
      li.appendChild(buildCardHeader(entry));
      if (isOpen) li.appendChild(buildCardBody(entry));
      else attachOpenHandler(li, entry.id);
      feed.appendChild(li);
    }

    entriesRoot.appendChild(feed);
  }

  /** Landscape: a narrow rail (every entry, collapsed to a row, live pinned
   * at top) alongside a single detail pane holding whichever entry is open. */
  function renderLandscape() {
    entriesRoot.dataset.layout = 'landscape';
    entriesRoot.innerHTML = '';

    const list = displayList();
    const open = list.find((entry) => entry.id === openEntryId) ?? list[0];

    const rail = document.createElement('nav');
    rail.className = 'entry-rail';
    rail.dataset.scrollKey = 'rail';

    const railList = document.createElement('ul');
    railList.className = 'entry-rail-list';
    for (const entry of list) {
      const isOpen = entry.id === open.id;
      const item = document.createElement('li');
      item.className = 'entry-rail-item' + (isOpen ? ' entry-rail-item--open' : '');
      if (entry.isLive) item.classList.add('entry-rail-item--live');
      const label = document.createElement('div');
      label.className = 'entry-rail-title';
      label.textContent = entry.title || (entry.isLive ? 'Current answer' : '(untitled)');
      item.appendChild(label);
      attachOpenHandler(item, entry.id);
      railList.appendChild(item);
    }
    rail.appendChild(railList);

    const detail = document.createElement('div');
    detail.className = 'entry-detail';
    detail.dataset.scrollKey = 'detail';
    detail.appendChild(buildCardHeader(open));
    detail.appendChild(buildCardBody(open));

    entriesRoot.append(rail, detail);
  }

  function render() {
    renderConnectionIndicator();
    renderFullscreenButton();

    const hasTarget = currentTarget !== null;
    picker.hidden = hasTarget;
    targetBar.hidden = !hasTarget;
    entriesRoot.hidden = !hasTarget;
    if (!hasTarget) return;

    targetLabel.textContent = `Watching: ${formatTarget(currentTarget)}`;

    const scrollPositions = captureScrollPositions();
    if (currentOrientation === 'landscape') renderLandscape();
    else renderPortrait();
    restoreScrollPositions(scrollPositions);
  }

  // -----------------------------------------------------------------------
  // Orientation. Several cheap triggers ask `computeOrientation()` to
  // re-check, because a missed one means the layout silently stops matching
  // the device -- verified necessary against prototype/21-web-client:
  // `orientationchange` in particular fires on Android before the resize
  // settles, so it re-checks again a frame later and once more after a short
  // delay rather than trusting the event's own timing.
  function handleOrientationSignal() {
    const next = computeOrientation();
    if (next === currentOrientation) return;
    currentOrientation = next;
    render();
  }

  window.matchMedia('(orientation: landscape)').addEventListener('change', handleOrientationSignal);
  window.addEventListener('resize', handleOrientationSignal);
  window.addEventListener('orientationchange', () => {
    handleOrientationSignal();
    requestAnimationFrame(handleOrientationSignal);
    setTimeout(handleOrientationSignal, 250);
  });

  // -----------------------------------------------------------------------
  // SSE wire.
  function connectEvents() {
    const source = new EventSource('/events');

    source.addEventListener('open', () => {
      connectionState = 'connected';
      render();
    });

    source.addEventListener('start', () => {
      demoteLiveEntry();
      liveEntry = { text: '', state: 'streaming', title: null, target: currentTarget, usage: null, timestamp: null };
      syncing = false;
      render();
    });

    source.addEventListener('delta', (event) => {
      const data = JSON.parse(event.data);
      if (!liveEntry) liveEntry = { text: '', state: 'streaming', title: null, target: currentTarget, usage: null, timestamp: null };
      liveEntry.text += data.text;
      syncing = false;
      render();
    });

    // Mid-flight join / reconnect catch-up (#31): the accumulated text so
    // far, in place of waiting silently for the next `start`, with a
    // transient "syncing…" tag (#34) until a real `delta` resumes.
    source.addEventListener('sync', (event) => {
      const data = JSON.parse(event.data);
      if (!liveEntry) liveEntry = { text: '', state: 'streaming', title: null, target: currentTarget, usage: null, timestamp: null };
      liveEntry.text = data.text;
      liveEntry.state = 'streaming';
      syncing = true;
      render();
    });

    source.addEventListener('done', (event) => {
      const data = JSON.parse(event.data);
      if (!liveEntry) liveEntry = { text: '', state: 'streaming', title: null, target: currentTarget, usage: null, timestamp: null };
      const title = parseAnswerTitle(liveEntry.text);
      liveEntry.title = title;
      liveEntry.state = title === BAIL_TITLE ? 'bail' : 'done';
      liveEntry.usage = data.usage;
      liveEntry.timestamp = new Date().toISOString();
      liveEntry.target = currentTarget;
      liveEntry.model = '';
      syncing = false;
      solveButton.disabled = currentTarget === null;
      render();
    });

    // EventSource dispatches both the server's named `event: error` frames
    // and native connection-level failures through this same listener name.
    // A wire frame always carries `data`; a connection error's `Event` does
    // not, which is how the two are told apart below.
    source.addEventListener('error', (event) => {
      solveButton.disabled = currentTarget === null;
      if (!event.data) {
        // Native failure -- EventSource retries on its own; `readyState`
        // says whether that retry is still coming (CONNECTING) or the
        // browser has given up for good (CLOSED).
        connectionState = source.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting';
        render();
        return;
      }
      const data = JSON.parse(event.data);
      solveError.hidden = false;
      solveError.textContent = `Solve failed (${data.kind}). The partial answer above is what streamed before it failed.`;
      if (liveEntry) liveEntry.state = 'error';
      syncing = false;
      render();
    });

    source.addEventListener('status', (event) => {
      const data = JSON.parse(event.data);
      setStatusPill(data.level, data.kind);
    });

    // #32's mid-run target loss can clear the target out from under an open
    // client with no action of its own -- and another client (or a future
    // second tab) picking a window should be reflected here too. Routed
    // through the same `applyConfig` the picker's own POST response uses.
    source.addEventListener('config', (event) => {
      const data = JSON.parse(event.data);
      applyConfigIfNewer(data.target, data.revision);
    });
  }

  loadConfig();
  loadHistory();
  connectEvents();
  render();
})();
