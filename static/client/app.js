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
//   GET  /events (SSE)      -> start/delta/done/error/sync/status/config{,revision}/recording
//
// Continuous screen recording (server contract as of this writing):
//   POST /recording/start   -> 200 {state,segmentId,startedAt,bytes} / 409 no_capture_session / 503
//   POST /recording/stop    -> 200 {state:'off'}
//   GET  /recordings        -> {id,startedAt,endedAt,bytes,durationMs,mimeType,target}[], newest first
//   GET  /recordings/file?id=<id> -> segment bytes, Range-capable (used directly as a <video> src)
//   GET  /recording/settings  -> {enabled,segmentSeconds,retentionBytes,retentionDays}
//   POST /recording/settings  -> same shape, accepts any subset of the four fields

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

  const recButton = document.getElementById('rec-button');
  const recStateLabel = document.getElementById('rec-state-label');
  const recordingError = document.getElementById('recording-error');
  const recordingIndicator = document.getElementById('recording-indicator');
  const recElapsed = document.getElementById('rec-elapsed');
  const recBytes = document.getElementById('rec-bytes');
  const recordingsList = document.getElementById('recordings-list');
  const recordingsError = document.getElementById('recordings-error');
  const recordingPlayer = document.getElementById('recording-player');
  const recordingSettingsForm = document.getElementById('recording-settings-form');
  const recordingSettingsError = document.getElementById('recording-settings-error');
  const recordingSettingsStatus = document.getElementById('rec-settings-status');
  const recSettingEnabled = document.getElementById('rec-setting-enabled');
  const recSettingSegmentSeconds = document.getElementById('rec-setting-segment-seconds');
  const recSettingRetentionBytes = document.getElementById('rec-setting-retention-bytes');
  const recSettingRetentionDays = document.getElementById('rec-setting-retention-days');

  /** @type {{processName: string, title: string} | null} */
  let currentTarget = null;
  let liveText = '';

  // The `recording` SSE frame is only replayed to a newly-connecting client
  // when the server-side state is not `'off'` (see the contract comment up
  // top) -- so if nothing arrives before the first render, `'off'` is the
  // correct assumption, not an unknown/loading state. `segmentId` starts as
  // `undefined` (not `null`) specifically so the very first frame -- even
  // one reporting `segmentId: null` -- is still treated as "different from
  // what we had" by {@link refreshRecordingsIfNeeded}'s `!==` check below.
  let recordingState = { state: 'off', segmentId: undefined, bytes: 0, startedAt: null, reason: null };
  let recordingRequestPending = false;
  let recordingTimerId = null;
  let currentVideoEl = null;
  let currentVideoLi = null;

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

    // The REC control is disabled with no target configured -- reuses this
    // existing state rather than the client re-fetching anything of its own.
    updateRecordingUI();
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

  /** KB/MB/GB, one decimal place -- matches the byte counter ticking up live on the recording indicator and the size shown per row in the recordings list. */
  function formatBytes(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = -1;
    do {
      value /= 1024;
      unitIndex++;
    } while (value >= 1024 && unitIndex < units.length - 1);
    return `${value.toFixed(1)} ${units[unitIndex]}`;
  }

  /** `H:MM:SS`, dropping the hour segment under an hour -- shared by the live elapsed-time readout and a finished recording's duration in the list. */
  function formatElapsedMs(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
  }

  function recordingIndicatorTick() {
    recElapsed.textContent = recordingState.startedAt
      ? formatElapsedMs(Date.now() - new Date(recordingState.startedAt).getTime())
      : '';
    recBytes.textContent = formatBytes(recordingState.bytes);
  }

  function startRecordingTimer() {
    if (recordingTimerId !== null) return;
    recordingTimerId = setInterval(recordingIndicatorTick, 1000);
  }

  function stopRecordingTimer() {
    if (recordingTimerId === null) return;
    clearInterval(recordingTimerId);
    recordingTimerId = null;
  }

  /** The single place that renders the REC button/label/indicator from {@link recordingState} plus {@link currentTarget} -- called on every `recording` SSE frame, on every config change (the target the button depends on can change out from under it), and around the button's own click handler while its request is in flight. Never flips state on click itself; only ever reflects what the last frame or fetch actually reported. */
  function updateRecordingUI() {
    const { state, reason } = recordingState;
    recordingError.hidden = true;

    if (state === 'unavailable') {
      recButton.disabled = true;
      recButton.textContent = 'Record';
      recStateLabel.textContent = reason
        ? `Recording is unavailable: ${reason}`
        : 'Recording is unavailable on this system.';
    } else if (currentTarget === null) {
      recButton.disabled = true;
      recButton.textContent = 'Record';
      recStateLabel.textContent = 'Pick a target window before recording.';
    } else if (recordingRequestPending) {
      recButton.disabled = true;
      recButton.textContent = state === 'off' || state === 'error' ? 'Starting…' : 'Stopping…';
      recStateLabel.textContent = '';
    } else if (state === 'starting') {
      recButton.disabled = true;
      recButton.textContent = 'Starting…';
      recStateLabel.textContent = 'Starting recording…';
    } else if (state === 'recording') {
      recButton.disabled = false;
      recButton.textContent = 'Stop recording';
      recStateLabel.textContent = '';
    } else if (state === 'error') {
      recButton.disabled = false;
      recButton.textContent = 'Retry recording';
      recStateLabel.textContent = '';
      recordingError.hidden = false;
      recordingError.textContent = reason ? `Recording error: ${reason}` : 'Recording error.';
    } else {
      // 'off'
      recButton.disabled = false;
      recButton.textContent = 'Record';
      recStateLabel.textContent = '';
    }

    recordingIndicator.hidden = state !== 'recording';
    if (state === 'recording') {
      recordingIndicatorTick();
      startRecordingTimer();
    } else {
      stopRecordingTimer();
    }
  }

  recButton.addEventListener('click', async () => {
    const action = recordingState.state === 'off' || recordingState.state === 'error' ? 'start' : 'stop';
    recordingRequestPending = true;
    updateRecordingUI();
    try {
      const res = await fetch(`/recording/${action}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          body.error === 'no_capture_session'
            ? 'no window is currently being captured'
            : body.error === 'not_ready'
              ? 'not ready yet -- try again in a moment'
              : body.error === 'shutting_down'
                ? 'the app is shutting down'
                : body.error || `unexpected status ${res.status}`;
        throw new Error(message);
      }
      // Deliberately not applied here even though the 200 body echoes the
      // same shape as a `recording` SSE frame -- the spec calls for the
      // control to reflect live SSE state only, never an optimistic flip on
      // click, so this response is consulted for its error shape alone and
      // the actual state transition is left to the frame that follows.
    } catch (err) {
      recordingError.hidden = false;
      recordingError.textContent = `Could not ${action} recording: ${err.message}`;
    } finally {
      recordingRequestPending = false;
      updateRecordingUI();
    }
  });

  function renderRecordingItem(entry) {
    const li = document.createElement('li');
    li.dataset.recordingId = entry.id;

    const title = document.createElement('div');
    title.className = 'recording-title';
    title.textContent = new Date(entry.startedAt).toLocaleString();

    const meta = document.createElement('div');
    meta.className = 'recording-meta';
    const durationText = entry.durationMs == null ? 'recording…' : formatElapsedMs(entry.durationMs);
    const targetText = entry.target ? formatTarget(entry.target) : '(unknown target)';
    meta.textContent = [durationText, formatBytes(entry.bytes), targetText].filter(Boolean).join(' · ');

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.textContent = 'Play';
    playButton.addEventListener('click', () => openRecording(entry, li));

    li.append(title, meta, playButton);
    return li;
  }

  /** Only one `<video>` open at a time -- tears down whatever was previously playing (pause + drop `src` + `load()`, the standard way to stop a buffering `<video>` from continuing to fetch) before mounting the next one, so switching rows never leaves more than one element buffering. */
  function openRecording(entry, li) {
    if (currentVideoEl) {
      currentVideoEl.pause();
      currentVideoEl.removeAttribute('src');
      currentVideoEl.load();
    }
    if (currentVideoLi) delete currentVideoLi.dataset.active;

    recordingPlayer.innerHTML = '';
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = `/recordings/file?id=${encodeURIComponent(entry.id)}`;
    recordingPlayer.appendChild(video);
    recordingPlayer.hidden = false;

    currentVideoEl = video;
    currentVideoLi = li;
    li.dataset.active = 'true';
  }

  async function loadRecordings() {
    recordingsError.hidden = true;
    try {
      const res = await fetch('/recordings');
      if (!res.ok) throw new Error(`GET /recordings -> ${res.status}`);
      const entries = await res.json();

      recordingPlayer.hidden = true;
      recordingPlayer.innerHTML = '';
      currentVideoEl = null;
      currentVideoLi = null;

      recordingsList.innerHTML = '';
      if (entries.length === 0) {
        recordingsList.appendChild(emptyHint('No recordings yet.'));
        return;
      }
      // Already newest-first per the contract -- appended in that order.
      for (const entry of entries) recordingsList.appendChild(renderRecordingItem(entry));
    } catch (err) {
      recordingsError.hidden = false;
      recordingsError.textContent = `Could not load recordings: ${err.message}`;
    }
  }

  function applyRecordingSettings(settings) {
    recSettingEnabled.checked = Boolean(settings.enabled);
    recSettingSegmentSeconds.value = settings.segmentSeconds;
    recSettingRetentionBytes.value = settings.retentionBytes;
    recSettingRetentionDays.value = settings.retentionDays;
  }

  // The recorder's state on first load. The `recording` SSE frame is replayed
  // on connect whenever the state isn't `off`, so this is strictly a
  // belt-and-braces read for the gap between the page rendering and the
  // EventSource actually opening -- without it, a phone opened during a
  // recording shows "not recording" for as long as that handshake takes, which
  // is the one thing this UI must never say. Mirrors what `loadConfig()`
  // already does for the target.
  async function loadRecordingState() {
    try {
      const res = await fetch('/recording');
      if (!res.ok) return;
      const snapshot = await res.json();
      // Never allowed to overwrite a live SSE frame that beat it here: the two
      // are independent, unordered sources for the same fact, the same problem
      // `GET /config`'s `revision` counter exists to solve. There is no
      // revision on this one, so the weaker but sufficient rule is "only fill
      // in a state nothing has reported yet".
      if (recordingState.state !== 'off') return;
      recordingState = snapshot;
      updateRecordingUI();
      if (snapshot.state !== 'off') loadRecordings();
    } catch {
      // A failure here costs nothing -- the SSE replay covers the same ground.
    }
  }

  async function loadRecordingSettings() {
    recordingSettingsError.hidden = true;
    try {
      const res = await fetch('/recording/settings');
      if (!res.ok) throw new Error(`GET /recording/settings -> ${res.status}`);
      applyRecordingSettings(await res.json());
    } catch (err) {
      recordingSettingsError.hidden = false;
      recordingSettingsError.textContent = `Could not load recording settings: ${err.message}`;
    }
  }

  recordingSettingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    recordingSettingsError.hidden = true;
    recordingSettingsStatus.hidden = true;
    try {
      const res = await fetch('/recording/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: recSettingEnabled.checked,
          segmentSeconds: Number(recSettingSegmentSeconds.value),
          retentionBytes: Number(recSettingRetentionBytes.value),
          retentionDays: Number(recSettingRetentionDays.value),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `unexpected status ${res.status}`);
      }
      applyRecordingSettings(await res.json());
      recordingSettingsStatus.hidden = false;
    } catch (err) {
      recordingSettingsError.hidden = false;
      recordingSettingsError.textContent = `Could not save recording settings: ${err.message}`;
    }
  });

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

    // Replayed immediately on connect whenever the server-side state isn't
    // `'off'` (see the contract comment up top), so this can fire before
    // anything else does -- `updateRecordingUI` doesn't care which frame is
    // "first", only what the latest one says. A changed `segmentId` (a
    // fresh start, or a roll to the next segment while still `'recording'`)
    // or a transition to `'off'` (a stop, which finalizes the segment that
    // was writing) both mean the `/recordings` list is now stale, so those
    // are the only two cases that trigger a re-fetch -- a same-segment
    // `bytes` tick every few seconds while recording does not.
    source.addEventListener('recording', (event) => {
      const data = JSON.parse(event.data);
      const shouldRefreshRecordings = data.state === 'off' || data.segmentId !== recordingState.segmentId;
      recordingState = data;
      updateRecordingUI();
      if (shouldRefreshRecordings) loadRecordings();
    });
  }

  loadConfig();
  loadHistory();
  loadRecordings();
  loadRecordingSettings();
  loadRecordingState();
  updateRecordingUI();
  connectEvents();
})();
