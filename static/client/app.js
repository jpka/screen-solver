// Screen Solver web client (#33) -- the functional core: connect to the live
// stream, show history, trigger a solve, pick a target window. Deliberately
// dependency-free (no bundler, no framework) per this repo's static/
// convention -- see AGENTS.md's "Product code: toolchain and layout".
//
// Talks to the wire contract built by #28/#29/#31/#32/#33/#35:
//   GET  /config              -> { targetWindow, revision }    (#33)
//   GET  /windows              -> WindowInfo[]                 (#33)
//   POST /config/target        -> { targetWindow, revision }   (#33)
//   GET  /answers              -> AnswerLogEntry[]              (#31)
//   POST /solve                 -> 202/400/503                   (#29)
//   GET  /recording             -> { state, sessionId, revision } (#35)
//   POST /recording  {on}       -> 200/400/413/503                (#35)
//   GET  /transcript?limit=N    -> TranscriptEntry[]               (#35)
//   POST /solve/with-transcript -> 202/400/503, same shape as /solve (#35)
//   GET  /events (SSE)  -> start/delta/done/error/sync/status/config{,revision}
//                          /recording/transcript/transcript-interim (#35)

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
  // #35 additions: record toggle, the second solve button, and the
  // transcript pane (finals + the two pinned per-channel interim rows).
  const recordToggleButton = document.getElementById('record-toggle');
  const solveTranscriptButton = document.getElementById('solve-transcript-button');
  const recordingError = document.getElementById('recording-error');
  const transcriptList = document.getElementById('transcript-list');
  const transcriptInterimThem = document.getElementById('transcript-interim-them');
  const transcriptInterimMe = document.getElementById('transcript-interim-me');

  /** @type {{processName: string, title: string} | null} */
  let currentTarget = null;
  let liveText = '';
  /** @type {'off' | 'starting' | 'on' | 'reconnecting' | 'unavailable' | 'error'} */
  let currentRecordingState = 'off';

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

  // Same ordering problem as `latestConfigRevision` above, for recording
  // state instead of the target window: it arrives from two independent,
  // unordered sources (the `recording` SSE frame, and this client's own
  // `GET /recording` / `POST /recording` responses), and arrival order says
  // nothing about which is more current. This is a *separate* counter from
  // `latestConfigRevision` -- the server tracks target-config and
  // recording-state revisions independently, so the two are never compared
  // against each other, only against their own kind.
  let latestRecordingRevision = -1;
  // Same queue-then-dedupe shape as `queuedLiveHistoryEntries` below, for
  // the transcript backfill instead of the answer history -- see
  // `loadTranscript` for the replay/de-dupe half of this.
  let transcriptSnapshotLoaded = false;
  const queuedLiveTranscriptEntries = [];

  /** Applies a recording `state` only if `revision` is at least as new as the last one actually applied -- the exact same shape as {@link applyConfigIfNewer} above, for the identical problem against `latestRecordingRevision` instead. Shared by all three sources of recording state (`GET /recording`, `POST /recording`, the `recording` SSE frame). */
  function applyRecordingIfNewer(state, revision) {
    if (revision < latestRecordingRevision) return;
    latestRecordingRevision = revision;
    applyRecording(state);
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
    // Solving with transcript needs a target too -- same 400
    // no_target_configured the plain solve gets without one.
    solveTranscriptButton.disabled = targetWindow === null;

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

  // Label for each of the six states `GET /recording` / `POST /recording` /
  // the `recording` SSE frame can report. `unavailable` means no
  // transcription key is configured server-side -- pressing the button can
  // never make it succeed, so it's the one state {@link applyRecording}
  // also disables the button for, rather than just relabeling it like the
  // other non-`off` states.
  const RECORDING_BUTTON_LABEL = {
    off: 'Start recording',
    starting: 'Starting…',
    on: 'Stop recording',
    reconnecting: 'Reconnecting…',
    unavailable: 'Recording unavailable',
    error: 'Recording error — retry',
  };

  /** The single place that updates the record toggle's label, `data-state` (styling hook for off/starting/on/reconnecting/unavailable/error), and enabled-ness. Reached only through {@link applyRecordingIfNewer}, mirroring how {@link applyConfig} is reached only through `applyConfigIfNewer`. */
  function applyRecording(state) {
    currentRecordingState = state;
    recordToggleButton.dataset.state = state;
    recordToggleButton.textContent = RECORDING_BUTTON_LABEL[state] || state;
    recordToggleButton.disabled = state === 'unavailable';

    // Nothing is being transcribed any more, so a pending interim line is now
    // a guess at a sentence that will never be finished -- it would otherwise
    // sit pinned at the bottom of the pane indefinitely, still styled as "in
    // progress", after recording stopped mid-word. The server makes the same
    // move on its side (`broadcaster.ts` clears its interim map on `off`, so
    // it is never replayed to a future client); this is the half that fixes
    // the client already looking at it. `starting`/`on`/`reconnecting` are
    // deliberately excluded -- those are all still-recording states, and a
    // reconnect in particular should leave the last line visible rather than
    // blanking the pane during a blip.
    if (state === 'off' || state === 'unavailable' || state === 'error') clearInterimLines();
  }

  function clearInterimLines() {
    for (const el of [transcriptInterimThem, transcriptInterimMe]) {
      el.hidden = true;
      el.querySelector('.transcript-text').textContent = '';
    }
  }

  async function loadRecording() {
    try {
      const res = await fetch('/recording');
      if (!res.ok) return;
      const body = await res.json();
      applyRecordingIfNewer(body.state, body.revision);
    } catch {
      // Left on the initial "off" default, same best-effort handling as
      // `loadConfig` -- the toggle stays clickable and its own click
      // handler's error path reports a real problem if there is one.
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

  recordToggleButton.addEventListener('click', async () => {
    recordingError.hidden = true;
    // Anything other than actively on/starting/reconnecting reads as "off"
    // for the purpose of deciding which way to flip -- `unavailable` never
    // reaches here since {@link applyRecording} disables the button for it,
    // and `error` should read as "off" (clicking it means "try again").
    const turnOn = !(
      currentRecordingState === 'on' ||
      currentRecordingState === 'starting' ||
      currentRecordingState === 'reconnecting'
    );
    recordToggleButton.disabled = true;
    try {
      const res = await fetch('/recording', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: turnOn }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `unexpected status ${res.status}`);
      }
      const body = await res.json();
      applyRecordingIfNewer(body.state, body.revision);
    } catch (err) {
      recordingError.hidden = false;
      recordingError.textContent = `Could not ${turnOn ? 'start' : 'stop'} recording: ${err.message}`;
      // Undo the disabled-while-in-flight state set above. `currentRecordingState`
      // wasn't touched by this catch (only a successful response reaches
      // `applyRecordingIfNewer`), so re-deriving from it here is safe -- a
      // fetch failure can't have turned it into `unavailable` out from under us.
      recordToggleButton.disabled = currentRecordingState === 'unavailable';
    }
  });

  // Mutual exclusion between the two solve buttons, wired as a *second*,
  // independent listener on each rather than by editing either handler's
  // body -- `#solve-button`'s handler in particular must stay byte-for-byte
  // unchanged, since it is the regression guard for "the plain button's
  // behavior is unchanged" (see the file-level comment / PR description).
  // The server only ever runs one solve at a time regardless of which
  // endpoint started it, so the other button has nothing useful to do until
  // this one's stream ends -- re-enabling happens in the shared `done`/
  // `error` SSE listeners below, for the same reason.
  solveButton.addEventListener('click', () => {
    solveTranscriptButton.disabled = true;
  });
  solveTranscriptButton.addEventListener('click', () => {
    solveButton.disabled = true;
  });

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

  // Duplicated from the `#solve-button` handler above rather than factored
  // out, per the same byte-for-byte constraint: sharing a helper would mean
  // editing that handler to call it. The only real difference is the
  // endpoint and which button owns the disabled state.
  solveTranscriptButton.addEventListener('click', async () => {
    solveError.hidden = true;
    solveTranscriptButton.disabled = true;
    try {
      const res = await fetch('/solve/with-transcript', { method: 'POST' });
      if (res.status !== 202) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `unexpected status ${res.status}`);
      }
      // Same "left disabled until done/error" reasoning as the plain button.
    } catch (err) {
      solveError.hidden = false;
      solveError.textContent = `Could not start a solve: ${err.message}`;
      solveTranscriptButton.disabled = currentTarget === null;
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

  /**
   * A transcript entry's identity for de-duplicating a queued live entry
   * against the `GET /transcript` snapshot (see {@link loadTranscript}) --
   * the same race {@link completionIdentity} guards against for history,
   * but without needing a heuristic: `recordingSessionId` + `channel` +
   * `startSeconds` really is a unique key the server assigns (one recording
   * session cannot produce two segments on the same channel starting at the
   * same offset), so there's no ambiguity to fold extra fields in against.
   */
  function transcriptEntryIdentity(entry) {
    return JSON.stringify([entry.recordingSessionId, entry.channel, entry.startSeconds]);
  }

  function interimElementFor(channel) {
    return channel === 'me' ? transcriptInterimMe : transcriptInterimThem;
  }

  /** Whether `el` is scrolled close enough to its own bottom that appending more content should pull it along. 24px of slop absorbs sub-pixel scroll rounding without mistaking "the user scrolled up on purpose to read back" for "at the bottom". */
  function isNearTranscriptBottom() {
    return transcriptList.scrollHeight - transcriptList.scrollTop - transcriptList.clientHeight < 24;
  }

  /**
   * Appends one finalized transcript line. Newest-at-bottom with
   * auto-scroll -- deliberately the opposite of `addHistoryEntry`'s
   * newest-at-top -- because a transcript is read top-down like a
   * conversation log, not scanned newest-first like a history of discrete
   * answers. Auto-scroll only fires when the pane was already near its
   * bottom (checked *before* appending), so scrolling back to read earlier
   * lines isn't yanked back down by the next line arriving.
   */
  function addTranscriptEntry(entry, { supersedesInterim = true } = {}) {
    const wasNearBottom = isNearTranscriptBottom();

    const line = document.createElement('div');
    line.className = 'transcript-line';
    line.dataset.channel = entry.channel;

    const channelLabel = document.createElement('span');
    channelLabel.className = 'transcript-channel';
    channelLabel.textContent = entry.channel === 'me' ? 'Me:' : 'Them:';

    const text = document.createElement('span');
    text.className = 'transcript-text';
    text.textContent = entry.text;

    line.append(channelLabel, text);
    // Inserted just above the two pinned interim rows -- see the comment on
    // those elements in index.html for why that keeps "newest final at the
    // bottom" true without ever having to move the interim rows themselves.
    transcriptList.insertBefore(line, transcriptInterimThem);

    // This channel's pending interim line, if any, describes text this
    // final has now superseded -- clear it so the words don't show twice
    // (once settled here, once still marked "in progress" below it).
    //
    // Skipped for backfill (`supersedesInterim: false`). `GET /transcript`
    // and the SSE connect race each other: the stream's connect-time interim
    // replay routinely lands *before* the slower fetch resolves, and those
    // backfilled finals are old -- often from an entirely previous recording
    // session -- so letting them clear the row would blank a live, currently-
    // being-spoken line that has nothing to do with them.
    if (supersedesInterim) {
      const interimEl = interimElementFor(entry.channel);
      interimEl.hidden = true;
      interimEl.querySelector('.transcript-text').textContent = '';
    }

    if (wasNearBottom) transcriptList.scrollTop = transcriptList.scrollHeight;
  }

  async function loadTranscript() {
    let entries = [];
    try {
      const res = await fetch('/transcript?limit=500');
      if (res.ok) entries = await res.json();
    } catch {
      // Best-effort, same as `loadHistory` -- a failed load just leaves the
      // pane short some backfill rather than blocking the rest of the page.
    }

    // Oldest-first within the slice is exactly the append order this pane
    // wants (newest-at-bottom) -- unlike `loadHistory`'s newest-first list,
    // nothing here needs reversing or inserting at the front.
    for (const entry of entries) addTranscriptEntry(entry, { supersedesInterim: false });

    // Same replay-then-dedupe as `loadHistory`: a `transcript` frame that
    // arrived while this fetch was in flight was queued instead of
    // rendered, and gets replayed now against what the snapshot already
    // contains -- see `transcriptEntryIdentity` for the (real, not
    // heuristic) key that comparison uses.
    transcriptSnapshotLoaded = true;
    const alreadyPersisted = new Set(entries.map(transcriptEntryIdentity));
    for (const queued of queuedLiveTranscriptEntries) {
      if (!alreadyPersisted.has(transcriptEntryIdentity(queued))) addTranscriptEntry(queued);
    }
    queuedLiveTranscriptEntries.length = 0;
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
      // Re-enables both buttons (whichever endpoint started this solve) --
      // see the mutual-exclusion comment above their click listeners.
      solveTranscriptButton.disabled = currentTarget === null;

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
      solveTranscriptButton.disabled = currentTarget === null;
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

    // Recording state changing under this client (another tab toggling it,
    // or this client's own `POST /recording` echoed back) -- routed through
    // the same `applyRecordingIfNewer` the toggle's own POST response uses.
    // Also what delivers connect-time catch-up: per the wire contract, a
    // fresh `/events` connection replays this frame whenever state isn't
    // `off`, so a client that opens mid-recording finds out promptly rather
    // than staying on the `off` default until the next real change.
    source.addEventListener('recording', (event) => {
      const data = JSON.parse(event.data);
      applyRecordingIfNewer(data.state, data.revision);
    });

    // A finalized transcript segment. See `loadTranscript` for why the
    // snapshot-vs-live race is handled with a queue instead of a revision
    // latch (transcript has no single "current value" to compare a
    // revision against, same as `done` completions and `queuedLiveHistoryEntries`).
    source.addEventListener('transcript', (event) => {
      const data = JSON.parse(event.data);
      if (transcriptSnapshotLoaded) addTranscriptEntry(data.entry);
      else queuedLiveTranscriptEntries.push(data.entry);
    });

    // Replaces the pending line for one channel wholesale -- no diffing, no
    // append. Also what delivers connect-time catch-up for a line already
    // in progress when this client opens the stream (the wire contract
    // replays the pending interim line per channel on connect, the same way
    // it replays the `recording` frame above).
    source.addEventListener('transcript-interim', (event) => {
      const data = JSON.parse(event.data);
      const wasNearBottom = isNearTranscriptBottom();
      const interimEl = interimElementFor(data.channel);
      interimEl.hidden = false;
      interimEl.querySelector('.transcript-text').textContent = data.text;
      if (wasNearBottom) transcriptList.scrollTop = transcriptList.scrollHeight;
    });
  }

  loadConfig();
  loadHistory();
  loadRecording();
  loadTranscript();
  connectEvents();
})();
