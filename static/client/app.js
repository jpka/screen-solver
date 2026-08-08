// Screen Solver web client (#33) -- the functional core: connect to the live
// stream, show history, trigger a solve, pick a target window. Deliberately
// dependency-free (no bundler, no framework) per this repo's static/
// convention -- see AGENTS.md's "Product code: toolchain and layout".
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

  const solveButton = document.getElementById('solve-button');
  const statusPill = document.getElementById('status-pill');
  const picker = document.getElementById('picker');
  const pickerError = document.getElementById('picker-error');
  const windowList = document.getElementById('window-list');
  const refreshWindowsButton = document.getElementById('refresh-windows');
  const answerPane = document.getElementById('answer-pane');
  const targetLabel = document.getElementById('target-label');
  const solveError = document.getElementById('solve-error');
  const answerText = document.getElementById('answer-text');
  const historyList = document.getElementById('history-list');

  /** @type {{processName: string, title: string} | null} */
  let currentTarget = null;
  let liveText = '';

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
  // History has no single "current value" to compare a revision against, so
  // it uses a queue instead: a `done` completion that lands before
  // `GET /answers` resolves is held here and replayed *after* the snapshot
  // renders (instead of being added straight to a DOM the snapshot is about
  // to clear), then filtered against what the snapshot already contains --
  // the recorder's JSONL write can complete before this client's own
  // `GET /answers` does, so the same answer can legitimately show up in
  // both the snapshot and the queue.
  let historySnapshotLoaded = false;
  const queuedLiveHistoryEntries = [];

  /** Applies `targetWindow` only if `revision` is at least as new as the last one actually applied, updating the latch either way it's compared against next time. Shared by all three sources of a target (`GET /config`, `POST /config/target`, the `config` SSE frame) so they can't disagree about ordering. */
  function applyConfigIfNewer(targetWindow, revision) {
    if (revision < latestConfigRevision) return;
    latestConfigRevision = revision;
    applyConfig(targetWindow);
  }

  function parseAnswerTitle(text) {
    const match = /^#[ \t]+(.+)$/m.exec(text);
    return match ? match[1].trim() : null;
  }

  function formatTarget(target) {
    if (!target) return '';
    return `${target.title} — ${target.processName}`;
  }

  /** The single place that flips between the picker and the answer pane. Reached only through {@link applyConfigIfNewer}, which all three sources of a target (an initial `GET /config`, a successful `POST /config/target`, a live `config` SSE frame) are funneled through, so this never has to arbitrate ordering itself. */
  function applyConfig(targetWindow) {
    currentTarget = targetWindow;
    solveButton.disabled = targetWindow === null;

    if (targetWindow === null) {
      picker.hidden = false;
      answerPane.hidden = true;
      loadWindows();
    } else {
      picker.hidden = true;
      answerPane.hidden = false;
      targetLabel.textContent = `Watching: ${formatTarget(targetWindow)}`;
    }
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

  function renderAnswer(text, state) {
    answerText.textContent = text;
    answerText.dataset.state = state;
  }

  function addHistoryEntry(entry) {
    const li = document.createElement('li');
    if (entry.interrupted) li.dataset.interrupted = 'true';

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = entry.title || '(untitled)';

    if (entry.title === BAIL_TITLE) {
      title.appendChild(badge('bail-badge', ' no exercise'));
    }
    if (entry.interrupted) {
      title.appendChild(badge('interrupted-badge', ' interrupted'));
    }

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const when = new Date(entry.timestamp);
    const usageText =
      entry.usage && (entry.usage.inputTokens || entry.usage.outputTokens)
        ? `${entry.usage.inputTokens} in / ${entry.usage.outputTokens} out`
        : '';
    meta.textContent = [when.toLocaleString(), entry.model, formatTarget(entry.target), usageText]
      .filter(Boolean)
      .join(' · ');

    li.append(title, meta);
    historyList.insertBefore(li, historyList.firstChild);
  }

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
   * A completion's identity for de-duplicating a queued live entry against
   * the `GET /answers` snapshot (see {@link loadHistory}). The server
   * assigns no client-visible ID to a solve, so this is necessarily a
   * heuristic -- but `text` alone is too weak (review feedback: solving the
   * same exercise twice in a row can legitimately produce byte-identical
   * output, which would make a real second answer look like a duplicate of
   * the first and get silently dropped). Folding in the target identity and
   * the *exact* token-usage tuple narrows this to "two independent calls
   * produced the same text *and* the same target *and* the same four usage
   * numbers" -- a provider call's real accounting varies with things the
   * client has no control over (retries, exact image bytes, prompt-cache
   * hits), so two genuinely different solves landing on identical usage as
   * well as identical text is not a realistic collision, even though it
   * remains possible in principle without a real ID from the server.
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

  async function loadHistory() {
    let entries = [];
    try {
      const res = await fetch('/answers');
      if (res.ok) entries = await res.json();
    } catch {
      // Best-effort: a failed load just leaves the snapshot half empty
      // rather than blocking the rest of the page -- the code below still
      // runs regardless, so any queued live completion is not lost either
      // way, just replayed on top of an empty-ish snapshot.
    }

    historyList.innerHTML = '';
    // Oldest first is appended first, so it ends up at the bottom -- the
    // newest logged entry lands on top, matching where `addHistoryEntry`
    // (called live, on a fresh `done`) always inserts.
    for (const entry of entries) addHistoryEntry(entry);

    // Whether the fetch succeeded or not, the snapshot phase is over -- any
    // `done` completion that arrived while it was in flight was queued
    // rather than rendered (it would have been wiped by `innerHTML = ''`
    // above). Replay it now, on top of what the snapshot just rendered --
    // except when the recorder's JSONL write already landed before this
    // fetch ran, in which case the snapshot above already contains it and
    // replaying would duplicate the row. See `completionIdentity` for what
    // "already contains it" is judged by, and why.
    historySnapshotLoaded = true;
    const alreadyPersisted = new Set(entries.map(completionIdentity));
    for (const queued of queuedLiveHistoryEntries) {
      if (!alreadyPersisted.has(completionIdentity(queued))) addHistoryEntry(queued);
    }
    queuedLiveHistoryEntries.length = 0;

    if (historyList.children.length === 0) historyList.appendChild(emptyHint('No answers yet.'));
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

  function connectEvents() {
    const source = new EventSource('/events');

    source.addEventListener('start', () => {
      liveText = '';
      renderAnswer('(waiting for the first token…)', 'streaming');
    });

    source.addEventListener('delta', (event) => {
      const data = JSON.parse(event.data);
      liveText += data.text;
      renderAnswer(liveText, 'streaming');
    });

    // Mid-flight join / reconnect catch-up (#31): the accumulated text so
    // far, in place of waiting silently for the next `start`.
    source.addEventListener('sync', (event) => {
      const data = JSON.parse(event.data);
      liveText = data.text;
      renderAnswer(liveText || '(waiting for the first token…)', 'streaming');
    });

    source.addEventListener('done', (event) => {
      const data = JSON.parse(event.data);
      const title = parseAnswerTitle(liveText);
      const isBail = title === BAIL_TITLE;
      renderAnswer(liveText, isBail ? 'bail' : 'done');
      solveButton.disabled = currentTarget === null;

      // A bail is never written to answers.jsonl (`logs/recorder.ts`) --
      // mirrored here rather than live-adding a history entry the server
      // itself would never have persisted. `currentTarget` is guaranteed
      // non-null here: `start` (and so `done`) can only follow a `POST
      // /solve` that itself required a configured target.
      if (!isBail && currentTarget !== null) {
        const entry = {
          title,
          text: liveText,
          timestamp: new Date().toISOString(),
          model: '',
          usage: data.usage,
          target: currentTarget,
        };
        // If the initial `GET /answers` snapshot hasn't rendered yet,
        // adding straight to the DOM here would just be wiped out by its
        // `innerHTML = ''` once it resolves -- queue it and `loadHistory()`
        // replays the queue right after rendering the snapshot instead.
        if (historySnapshotLoaded) addHistoryEntry(entry);
        else queuedLiveHistoryEntries.push(entry);
      }
    });

    // EventSource dispatches both the server's named `event: error` frames
    // and native connection-level failures through this same listener name.
    // A wire frame always carries `data`; a connection error's `Event` does
    // not, which is how the two are told apart below.
    source.addEventListener('error', (event) => {
      solveButton.disabled = currentTarget === null;
      if (!event.data) return;
      const data = JSON.parse(event.data);
      solveError.hidden = false;
      solveError.textContent = `Solve failed (${data.kind}). The partial answer above is what streamed before it failed.`;
      answerText.dataset.state = 'error';
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
})();
