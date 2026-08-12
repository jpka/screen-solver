// Screen Solver web client (#33/#34) -- connect to the live stream, show
// history, trigger a solve, pick a target window, and lay all of that out
// for a phone: two layouts picked by orientation, swapping live with no
// reload and no lost state, plus fullscreen. Deliberately dependency-free
// (no bundler, no framework) per this repo's static/ convention -- see
// AGENTS.md's "Product code: toolchain and layout".
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
//   POST /solve/transcript-only -> 202/400/503, speech only, no target needed
//   GET  /events (SSE)  -> start/delta/done/error/sync/status/config{,revision}
//                          /recording/transcript/transcript-interim (#35)

(() => {
  'use strict';

  // Mirrors `src/host/logs/title.ts`'s two bail markers -- the client has no
  // server-side module to import, so these are kept in lockstep by hand. Only
  // used to decide *display* emphasis; the server remains the sole authority
  // on what actually gets persisted.
  //
  // Two markers, not one: a screenshot-carrying solve bails with "no exercise
  // on screen", while a speech-only solve (which was shown no screen at all)
  // bails with "no question in the recent speech". They mean the same thing
  // here -- this answer answered nothing -- so `isBailTitle` collapses them
  // the way the server's own `isBailTitle()` does, and the badge below names
  // whichever one actually came back.
  const BAIL_TITLE = 'No exercise on screen';
  const NO_QUESTION_TITLE = 'No question in the recent speech';

  function isBailTitle(title) {
    return title === BAIL_TITLE || title === NO_QUESTION_TITLE;
  }

  /** What the bail badge says, per marker -- "no exercise" would be a lie about a request that had no screen. */
  function bailBadgeText(title) {
    return title === NO_QUESTION_TITLE ? ' no question' : ' no exercise';
  }

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
  // #35 additions: record toggle, the second solve button, and the transcript
  // pane (finals plus the two pinned per-channel interim rows). The pane is
  // static markup rather than something render() draws -- see index.html.
  const recordToggleButton = document.getElementById('record-toggle');
  const solveTranscriptButton = document.getElementById('solve-transcript-button');
  // This ticket's third solve button -- speech only, no screenshot, no
  // target. See its enabled-ness comment (`hasHeardSpeech`/`markSpeechHeard`)
  // below for why it is wired independently of `applyConfig`.
  const solveVoiceButton = document.getElementById('solve-voice-button');
  const transcriptPane = document.getElementById('transcript-pane');
  const recordingError = document.getElementById('recording-error');
  const transcriptList = document.getElementById('transcript-list');
  const transcriptInterimThem = document.getElementById('transcript-interim-them');
  const transcriptInterimMe = document.getElementById('transcript-interim-me');

  /** @type {{processName: string, title: string} | null} */
  let currentTarget = null;

  /**
   * Whether `#solve-voice-button` should be enabled -- a heuristic, and
   * deliberately so. The button needs *some* recent speech, not a target
   * (`applyConfig` never touches it), but "recent" is a server-side
   * bounded-window concept (the 5-minute transcript buffer `POST
   * /solve/transcript-only`'s own `400 no_transcript` guards) that this
   * client cannot evaluate itself. So this only ever tracks "has this client
   * seen at least one finalized transcript line at some point" -- from the
   * `GET /transcript` snapshot `loadTranscript()` loads, or a live
   * `transcript` SSE frame -- and once true, stays true; it never flips back
   * off as time passes, even though the server-side window it was inferring
   * from may since have emptied. That's fine: the button merely offers the
   * attempt, and the server's `400 no_transcript` (mapped to a human
   * sentence in the click handler below) is the authoritative refusal when
   * this guess turns out to be stale.
   */
  let hasHeardSpeech = false;

  function markSpeechHeard() {
    if (hasHeardSpeech) return;
    hasHeardSpeech = true;
    solveVoiceButton.disabled = false;
  }

  // Set for the duration of a speech-only solve *this client* initiated, so
  // the next `start`/`done` SSE frame stamps `liveEntry.target = null`
  // instead of `currentTarget` -- a speech-only answer genuinely has no
  // target (the server records `target: null` for it), and stamping
  // whatever window this client happens to be watching would mislabel the
  // entry's meta line with a window the answer had nothing to do with.
  //
  // This is best-effort and purely local: the wire carries no marker of
  // *which* button started a solve, so a speech-only solve triggered from
  // another device (or another tab) is indistinguishable here from a normal
  // one and will still get stamped with `currentTarget`, wrongly. The
  // authoritative record is whatever the next `GET /answers` reports, where
  // `target` is genuinely `null` for a speech-only entry regardless of what
  // this flag guessed in the meantime.
  let voiceSolveInFlight = false;

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
  // frozen with a stable `_uid` (the UI selection identity) the moment it's
  // created -- see the doc comment on `nextEntryUid` below for why that's a
  // separate field from `_id`, the content-fingerprint identity used only
  // for dedup.
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

  // Same ordering problem as `latestConfigRevision` above, for recording
  // state instead of the target window: it arrives from two independent,
  // unordered sources (the `recording` SSE frame, and this client's own
  // `GET /recording` / `POST /recording` responses), and arrival order says
  // nothing about which is more current. This is a *separate* counter from
  // `latestConfigRevision` -- the server tracks target-config and
  // recording-state revisions independently, so the two are never compared
  // against each other, only against their own kind.
  let latestRecordingRevision = -1;
  // Same queue-then-dedupe shape as `queuedDemotedEntries` above, for the
  // transcript backfill instead of the answer history -- see `loadTranscript`
  // for the replay/de-dupe half of this.
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

  /** The single place that flips between the picker and the entry views. Reached only through {@link applyConfigIfNewer}, which all three sources of a target (an initial `GET /config`, a successful `POST /config/target`, a live `config` SSE frame) are funneled through, so this never has to arbitrate ordering itself. */
  function applyConfig(targetWindow) {
    currentTarget = targetWindow;
    solveButton.disabled = targetWindow === null;
    // Solving with transcript needs a target too -- it takes the same 400
    // no_target_configured the plain solve gets without one.
    solveTranscriptButton.disabled = targetWindow === null;
    // `#solve-voice-button` is deliberately left untouched here -- it needs
    // speech, not a target (see `hasHeardSpeech`'s doc comment), so having no
    // target configured at all must not disable it the way it disables the
    // other two.
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

    updateTranscriptPaneVisibility();
  }

  /**
   * Shows the transcript pane only when it has something to say.
   *
   * Screen space is the scarce resource in #34's layouts -- a phone in
   * portrait gives the whole viewport to one continuous log -- so an empty
   * "Transcript" heading permanently occupying a chunk of it, on a machine
   * that may have no transcription key at all, is a bad trade. It appears
   * once recording starts or once there is backfill to show, and stays put
   * afterwards so that stopping doesn't yank away lines you are still reading.
   */
  function updateTranscriptPaneVisibility() {
    const recordingActive =
      currentRecordingState === 'starting' ||
      currentRecordingState === 'on' ||
      currentRecordingState === 'reconnecting';
    const hasLines = transcriptList.querySelector('.transcript-line:not(.transcript-interim)') !== null;
    if (recordingActive || hasLines) transcriptPane.hidden = false;
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

  // This ticket's third button folds into the same mesh via *more*
  // independent listeners, rather than editing the two above -- same
  // byte-for-byte-handler reasoning as the click handlers themselves (adding
  // a second `click` listener to an element is additive; `addEventListener`
  // happily runs both). `solveVoiceButton` disabling itself is handled by
  // its own click handler below, matching how `solveButton`/
  // `solveTranscriptButton` each disable *themselves* in their own handlers.
  solveButton.addEventListener('click', () => {
    solveVoiceButton.disabled = true;
  });
  solveTranscriptButton.addEventListener('click', () => {
    solveVoiceButton.disabled = true;
  });
  solveVoiceButton.addEventListener('click', () => {
    solveButton.disabled = true;
    solveTranscriptButton.disabled = true;
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
  // editing that handler to call it, and that handler is the regression guard
  // for "the plain button's behavior is unchanged". The only real differences
  // are the endpoint and which button owns the disabled state.
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

  // Same shape again: modelled on `#solve-button`'s handler (hide
  // `solveError`, disable itself, POST, throw on anything but 202, surface
  // the failure), duplicated rather than shared for the same byte-for-byte
  // reasoning. Two real differences beyond the endpoint and which button
  // owns the disabled state: (1) `no_transcript` -- the one refusal unique to
  // this route, since there is no target to be missing -- gets mapped to a
  // human sentence instead of showing the raw error code; (2) it sets
  // `voiceSolveInFlight` so the `start`/`done` SSE listeners know to stamp
  // this attempt's `target` as `null` (see that flag's own doc comment).
  solveVoiceButton.addEventListener('click', async () => {
    solveError.hidden = true;
    solveVoiceButton.disabled = true;
    voiceSolveInFlight = true;
    try {
      const res = await fetch('/solve/transcript-only', { method: 'POST' });
      if (res.status !== 202) {
        const body = await res.json().catch(() => ({}));
        if (body.error === 'no_transcript') {
          throw new Error('Nothing has been said recently. Start recording and ask your question out loud.');
        }
        throw new Error(body.error || `unexpected status ${res.status}`);
      }
      // Same "left disabled until done/error" reasoning as the other two.
    } catch (err) {
      solveError.hidden = false;
      solveError.textContent = `Could not start a solve: ${err.message}`;
      solveVoiceButton.disabled = !hasHeardSpeech;
      // The attempt never actually reached the server (or was rejected
      // outright), so there is no in-flight speech-only solve for a later
      // `start`/`done` to stamp `target: null` for.
      voiceSolveInFlight = false;
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

  // A history entry carries two different identities, deliberately kept
  // apart (Greptile review on this PR): `_id` (`completionIdentity`) is a
  // *content* fingerprint, used only to answer "does the snapshot already
  // contain this" during the merge below -- it's fine, even correct, for
  // two independent entries to collide on it, since that's exactly what
  // marks a queued fold as already-persisted. `_uid` is a per-entry
  // identity for the UI (`openEntryId`, both layouts' click-to-open), and
  // has to be unique per entry even when the content is byte-identical --
  // `completionIdentity`'s own doc comment already calls out that solving
  // the same exercise twice in a row can legitimately produce identical
  // text *and* usage. Reusing the content fingerprint as the UI id (an
  // earlier version of this file did) collapses two such entries onto one
  // selectable card and strands the other, unreachable.
  let nextEntryUid = 1;

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
      const finished = { ...liveEntry, _id: completionIdentity(liveEntry), _uid: nextEntryUid++ };
      if (historySnapshotLoaded) historyEntries.unshift(finished);
      else queuedDemotedEntries.push(finished);
    }
    liveEntry = null;
    // `openEntryId` is left untouched: if it was `'live'`, it now naturally
    // refers to whatever `start` sets up next (the whole point of the
    // sentinel); if it was pointing at some other history entry, that
    // entry's `_uid` is unaffected by this fold.
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
      .map((entry) => ({ ...entry, _id: completionIdentity(entry), _uid: nextEntryUid++ }));

    // Whether the fetch succeeded or not, the snapshot phase is over -- any
    // fold that happened while it was in flight was queued rather than
    // spliced in directly (it would have been wiped by the assignment
    // above). Replay it now, on top of what the snapshot just produced --
    // except when the recorder's JSONL write already landed before this
    // fetch ran, in which case the snapshot above already contains it and
    // replaying would duplicate the row. Matched on `_id` (the content
    // fingerprint), not `_uid` -- see the identity doc comment above.
    //
    // A *count* per fingerprint, not a `Set` (review, round 2): two
    // genuinely distinct completed attempts can share a fingerprint (the
    // same "solving the same exercise twice in a row" case `_id`'s own doc
    // comment already flags), and can both be queued while only one of them
    // has actually landed in the snapshot yet (the recorder's writes don't
    // all complete before this fetch resolves). A `Set.has()` membership
    // check can't tell "already accounted for by the snapshot" from
    // "another queued entry with the same fingerprint already claimed
    // that", so it dropped *both* -- silently losing a real completed
    // attempt. Decrementing a count as each queued entry claims one
    // snapshot occurrence makes only as many queued entries "already
    // there" as the snapshot actually contains that many times.
    historySnapshotLoaded = true;
    const remainingInSnapshot = new Map();
    for (const entry of historyEntries) {
      remainingInSnapshot.set(entry._id, (remainingInSnapshot.get(entry._id) ?? 0) + 1);
    }
    for (const queued of queuedDemotedEntries) {
      const remaining = remainingInSnapshot.get(queued._id) ?? 0;
      if (remaining > 0) remainingInSnapshot.set(queued._id, remaining - 1);
      else historyEntries.unshift(queued);
    }
    queuedDemotedEntries.length = 0;

    render();
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
   * auto-scroll -- deliberately the opposite of the newest-first ordering
   * `historyEntries` uses -- because a transcript is read top-down like a
   * conversation log, not scanned newest-first like a history of discrete
   * answers. Auto-scroll only fires when the pane was already near its
   * bottom (checked *before* appending), so scrolling back to read earlier
   * lines isn't yanked back down by the next line arriving.
   */
  function addTranscriptEntry(entry, { supersedesInterim = true } = {}) {
    // Every finalized line -- backfilled from `GET /transcript` or a live
    // `transcript` SSE frame, replayed-from-queue or not -- passes through
    // here, so this is the one place `hasHeardSpeech` needs to be set from.
    // See its doc comment for why this is "has ever heard speech", not "has
    // speech within the server's window right now".
    markSpeechHeard();

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
    // Backfill can arrive with recording already stopped (a previous
    // session's lines), which is still a reason to show the pane.
    updateTranscriptPaneVisibility();

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
    const history = historyEntries.map((entry) => ({ ...entry, id: entry._uid, isLive: false }));
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
    if (entry.isLive && entry.state === 'bail') {
      title.appendChild(badge('bail-badge', bailBadgeText(entry.title)));
    }
    if (!entry.isLive && isBailTitle(entry.title)) {
      title.appendChild(badge('bail-badge', bailBadgeText(entry.title)));
    }
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
      // A speech-only entry's `target` is genuinely `null` (see
      // `voiceSolveInFlight`'s doc comment), so `formatTarget` returns ''
      // for it -- `.filter(Boolean)` drops that empty segment before the
      // join, rather than leaving a dangling ` · ` where the window label
      // would otherwise have gone.
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

  /**
   * What to stamp a fresh/finishing `liveEntry.target` with. Normally
   * `currentTarget` (the window this client is watching), except while
   * `voiceSolveInFlight` -- see that flag's own doc comment on why a
   * speech-only solve this client itself started needs `null` here instead,
   * and why that is only ever a best-effort local guess.
   */
  function liveEntryTargetStamp() {
    return voiceSolveInFlight ? null : currentTarget;
  }

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
      liveEntry = { text: '', state: 'streaming', title: null, target: liveEntryTargetStamp(), usage: null, timestamp: null };
      syncing = false;
      render();
    });

    source.addEventListener('delta', (event) => {
      const data = JSON.parse(event.data);
      if (!liveEntry) liveEntry = { text: '', state: 'streaming', title: null, target: liveEntryTargetStamp(), usage: null, timestamp: null };
      liveEntry.text += data.text;
      syncing = false;
      render();
    });

    // Mid-flight join / reconnect catch-up (#31): the accumulated text so
    // far, in place of waiting silently for the next `start`, with a
    // transient "syncing…" tag (#34) until a real `delta` resumes.
    source.addEventListener('sync', (event) => {
      const data = JSON.parse(event.data);
      if (!liveEntry) liveEntry = { text: '', state: 'streaming', title: null, target: liveEntryTargetStamp(), usage: null, timestamp: null };
      liveEntry.text = data.text;
      liveEntry.state = 'streaming';
      syncing = true;
      render();
    });

    source.addEventListener('done', (event) => {
      const data = JSON.parse(event.data);
      if (!liveEntry) liveEntry = { text: '', state: 'streaming', title: null, target: liveEntryTargetStamp(), usage: null, timestamp: null };
      const title = parseAnswerTitle(liveEntry.text);
      liveEntry.title = title;
      liveEntry.state = isBailTitle(title) ? 'bail' : 'done';
      liveEntry.usage = data.usage;
      liveEntry.timestamp = new Date().toISOString();
      liveEntry.target = liveEntryTargetStamp();
      liveEntry.model = '';
      syncing = false;
      // The solve this client itself initiated (if any) has now ended --
      // see `voiceSolveInFlight`'s doc comment for why this has to be
      // cleared here rather than left set for the next attempt.
      voiceSolveInFlight = false;
      solveButton.disabled = currentTarget === null;
      // Re-enables all three buttons regardless of which endpoint started
      // this solve -- see the mutual-exclusion comment above their click
      // listeners. `#solve-voice-button`'s enabled-ness depends on whether
      // this client has ever heard speech, not on `currentTarget`.
      solveTranscriptButton.disabled = currentTarget === null;
      solveVoiceButton.disabled = !hasHeardSpeech;
      render();
    });

    // EventSource dispatches both the server's named `event: error` frames
    // and native connection-level failures through this same listener name.
    // A wire frame always carries `data`; a connection error's `Event` does
    // not, which is how the two are told apart below.
    source.addEventListener('error', (event) => {
      solveButton.disabled = currentTarget === null;
      solveTranscriptButton.disabled = currentTarget === null;
      solveVoiceButton.disabled = !hasHeardSpeech;
      // Same "the solve this client initiated has ended" clearing as `done`
      // above -- run unconditionally here too (rather than only inside the
      // wire-frame branch below) to match the existing re-enable lines just
      // above, which already treat a native connection error the same as a
      // wire `error` frame for the purpose of un-disabling the buttons.
      voiceSolveInFlight = false;
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
    // revision against, same as demoted entries and `queuedDemotedEntries`).
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
  render();
})();
