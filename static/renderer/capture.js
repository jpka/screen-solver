// The hidden renderer's capture mechanism (#30). Plain JavaScript on purpose:
// `static/` is loaded/served as-is, never compiled or transpiled (see
// AGENTS.md), so nothing here can be TypeScript.
//
// No decision logic belongs in this file -- gating on "should we even try to
// capture" (minimized, vanished-from-enumeration) and "was this frame good
// enough to spend a model call on" (the black/zero-size ratio check) both
// live in src/host/capture/, run from main. This file only does mechanism:
// turn a desktopCapturer source into a live MediaStream via getUserMedia,
// draw frames to a canvas, downscale to 1568px on the long edge with no
// crop, encode, and hand bytes (plus the raw downscaled pixels the host-side
// ratio check needs) back to main over the IPC surface `preload.js` exposes
// as `window.captureHost`.
(() => {
  'use strict';

  // Matches the spec's "Model defaults": captures are downscaled to 1568px
  // on the long edge, never cropped.
  const CAPTURE_LONG_EDGE = 1568;
  const ENCODE_MEDIA_TYPE = 'image/jpeg';
  const ENCODE_QUALITY = 0.85;

  /** @type {MediaStream|null} */
  let stream = null;
  /** @type {HTMLVideoElement|null} */
  let videoEl = null;
  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  let ctx = null;

  // Recording state (#47). This MediaRecorder sits on top of `stream` --
  // whatever getUserMedia grab is already live for the capture feature above
  // -- rather than opening a second one. A second getUserMedia against the
  // same desktopCapturer source would light a second OS capture session (a
  // second indicator border for one window) and would drift out of sync with
  // whatever the capture side thinks it's watching, since stopStream()/
  // openSession() above can swap `stream` out from under a long-lived
  // recorder that grabbed its own.
  /** @type {MediaRecorder|null} */
  let recorder = null;
  /** Segment id the currently-live `recorder` is tagging its chunks with. */
  let currentSegmentId = null;
  /** Negotiated once at startRecording() and reused for every later segment. */
  let recordingMimeType = null;
  /** Session key main minted for the live recording; echoed on every status so a
   *  superseded session's late messages can be told apart from this one's. */
  let currentRecordingSession = null;
  /** Timeslice main asked for at startRecording() time; every roll reuses it. */
  let recordingTimesliceMs = null;

  const RECORDING_MIME_CANDIDATES = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=h264',
    'video/mp4',
  ];

  // Bumped by every open/close request. `openSession` is async (it awaits
  // getUserMedia, which is not instantaneous), so a `close` -- or a newer
  // `open` -- can arrive from main while a previous `openSession` call is
  // still in flight. Main's own coordinator (src/host/capture/session-
  // coordinator.ts) already serializes what it *asks for* via a generation
  // counter, but its real opener (src/main/capture-session.ts) resolves as
  // soon as the `open` IPC message is sent, not once the renderer has
  // actually finished setting up the stream -- so a superseding `close` is
  // routinely sent before that stream exists yet. Without this guard, such a
  // `close` would arrive while `stream`/`videoEl` are still null (nothing to
  // stop), and the in-flight `openSession` would then finish and assign a
  // live stream anyone believes is closed -- a leaked session and a
  // capture-indicator border lit for a target that was already deselected.
  let sessionToken = 0;

  // stopStream() is `async` (#47) so it can flush a live recorder before it
  // rips the tracks that recorder is reading out from under it. Its callers
  // (openSession, closeSession) were already fine awaiting it -- openSession
  // is async itself, and closeSession's caller below already tolerates a
  // promise -- so making this async cost nothing and closes a real hole: a
  // MediaRecorder.stop() only flushes its buffered data on the next
  // `dataavailable`/`onstop` pair, which needs the tracks it's reading from
  // to still be alive to fire. Stopping tracks first would truncate whatever
  // was still buffered, silently losing the tail of a segment.
  async function stopStream() {
    const hadActiveRecorder = recorder !== null;
    await stopCurrentRecorder();
    if (hadActiveRecorder) {
      // The stream a live recording was riding on is going away with no
      // stop/roll from main -- a target change, or the session simply
      // closing. Report it the same way any other mid-session recorder
      // failure is reported (RecorderFailure's channel, per
      // src/host/recording/types.ts): once stopCurrentRecorder() above has
      // returned there is no more MediaRecorder for main to talk to, and
      // main has no other way to learn that.
      recordingMimeType = null;
      recordingTimesliceMs = null;
      reportCurrentStatus({ state: 'failed', reason: 'capture stream stopped underneath the active recording' });
      currentRecordingSession = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (videoEl) {
      videoEl.pause();
      videoEl.srcObject = null;
      videoEl = null;
    }
  }

  /**
   * Opens a live stream against one desktopCapturer source id. Held open
   * (never re-grabbed) until the next open or close message arrives -- the
   * spec's "one long-lived session per target, not one per solve" rule is
   * enforced by main (src/host/capture/session-coordinator.ts); this
   * function just does whatever main tells it to do.
   */
  async function openSession(sourceId) {
    const token = (sessionToken += 1);
    await stopStream();

    // getUserMedia's legacy `mandatory` constraint syntax is what Electron's
    // desktopCapturer integration actually requires; there is no standard
    // MediaTrackConstraints shape for "capture this specific window".
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
          },
        },
      });
    } catch (error) {
      if (token !== sessionToken) return; // superseded before the grab even resolved; nothing to clean up
      throw error;
    }

    if (token !== sessionToken) {
      // A close (or a newer open) arrived while getUserMedia was in flight.
      // Tear down what was just grabbed instead of adopting it as live.
      for (const track of newStream.getTracks()) track.stop();
      return;
    }

    stream = newStream;
    videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.srcObject = stream;
    await videoEl.play();

    if (token !== sessionToken) {
      // Superseded again while awaiting play() -- tear down what was just built.
      await stopStream();
    }
  }

  async function closeSession() {
    sessionToken += 1;
    await stopStream();
  }

  /**
   * Grabs whatever the currently open stream is showing right now, downscales
   * with no crop, encodes, and hands back both the encoded bytes (for the
   * provider) and the raw downscaled pixel bytes (input to the host-side
   * black/zero-size ratio check -- see src/host/capture/frame-quality.ts).
   * Never opens a fresh grab; if nothing is open, this reports failure rather
   * than starting one, since opening on demand is exactly the per-solve
   * flicker the spec's capture session lifecycle rules out.
   */
  async function captureFrame() {
    if (!videoEl || videoEl.readyState < 2 /* HAVE_CURRENT_DATA */) {
      return { ok: false, reason: 'no-active-session' };
    }

    const sourceWidth = videoEl.videoWidth;
    const sourceHeight = videoEl.videoHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return { ok: false, reason: 'zero-size-source' };
    }

    const longEdge = Math.max(sourceWidth, sourceHeight);
    const scale = Math.min(1, CAPTURE_LONG_EDGE / longEdge);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    if (!canvas) {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(videoEl, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('canvas.toBlob produced no blob'))),
        ENCODE_MEDIA_TYPE,
        ENCODE_QUALITY,
      );
    });
    const encodedBytes = new Uint8Array(await blob.arrayBuffer());

    return {
      ok: true,
      width,
      height,
      mediaType: ENCODE_MEDIA_TYPE,
      bytesBase64: bytesToBase64(encodedBytes),
      pixelsBase64: bytesToBase64(new Uint8Array(imageData.data.buffer)),
    };
  }

  function bytesToBase64(bytes) {
    let binary = '';
    // Chunked to stay well under String.fromCharCode's argument-count limits
    // on the larger (up to ~1568x1568x4 raw pixel) buffers this handles.
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  // --- Continuous recording (#47) -------------------------------------
  //
  // A MediaRecorder over the same `stream` the capture feature above already
  // owns -- see stopStream()'s comment for why this never calls getUserMedia
  // a second time. Everything here is mechanism: main (src/main/recording.ts,
  // driven by src/host/recording/) decides when to start, when to roll to a
  // new segment, and when to stop; this file just does whatever it's told
  // and reports back what actually happened.

  /**
   * Base64-encodes one recorder chunk and sends it to main over
   * window.screenRecordingHost, tagged with the segment it belongs to.
   */
  async function sendChunk(segmentId, blob, last) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    window.screenRecordingHost.sendChunk({ segmentId, bytesBase64: bytesToBase64(bytes), last });
  }

  // Every status carries the session it belongs to. Main drops anything whose
  // session it doesn't recognise, which is what stops a slow teardown -- one
  // main already timed out on and moved past -- from landing in the *next*
  // session's start handshake. See src/main/screen-recording-ipc-channels.ts.
  function reportStatus(sessionId, message) {
    window.screenRecordingHost.sendStatus({ ...message, sessionId });
  }

  /** Reports against whatever session is live right now, for unsolicited failures. */
  function reportCurrentStatus(message) {
    if (currentRecordingSession === null) return;
    reportStatus(currentRecordingSession, message);
  }

  /**
   * Stops whatever recorder is currently live and resolves once its final
   * chunk (tagged `last: true`, with the segment id it was still recording)
   * has been handed to main -- awaiting both the flushing `dataavailable`
   * and the subsequent `onstop`, since a MediaRecorder's buffered data isn't
   * final until both have fired. A no-op (resolves immediately, sends
   * nothing) when no recorder is live, so callers -- roll, stop, and
   * stopStream()'s teardown path -- don't each need their own "is there
   * even a recorder" guard.
   */
  function stopCurrentRecorder() {
    const activeRecorder = recorder;
    const activeSegmentId = currentSegmentId;
    recorder = null;
    currentSegmentId = null;

    if (!activeRecorder || activeRecorder.state === 'inactive') {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let finalBlob = null;
      let stopped = false;

      function maybeFinish() {
        if (finalBlob === null || !stopped) return;
        // Best-effort: even if the base64 encode/send somehow throws, this
        // stop is still complete from the caller's point of view.
        Promise.resolve(sendChunk(activeSegmentId, finalBlob, true)).then(resolve, resolve);
      }

      // A stopped MediaRecorder is guaranteed to fire a final
      // `dataavailable` (even with an empty blob) before `onstop`, but the
      // two-flag join below doesn't assume an order beyond that guarantee.
      activeRecorder.ondataavailable = (event) => {
        finalBlob = event.data;
        maybeFinish();
      };
      activeRecorder.onstop = () => {
        stopped = true;
        if (finalBlob === null) finalBlob = new Blob([]);
        maybeFinish();
      };
      activeRecorder.onerror = () => {
        stopped = true;
        if (finalBlob === null) finalBlob = new Blob([]);
        maybeFinish();
      };
      activeRecorder.stop();
    });
  }

  /**
   * Constructs and starts a fresh MediaRecorder tagged with `segmentId`,
   * using whatever mime type/timeslice startRecording() already negotiated.
   * Used both for the initial start and for the second half of a roll.
   */
  function createRecorder(segmentId) {
    const newRecorder = new MediaRecorder(stream, { mimeType: recordingMimeType });
    recorder = newRecorder;
    currentSegmentId = segmentId;

    newRecorder.ondataavailable = (event) => {
      // Dropped silently rather than thrown: a stale event from a recorder
      // that roll()/stop() has already replaced (its handlers would have
      // been overwritten by stopCurrentRecorder() first, so this only fires
      // for the still-current recorder) or an empty timeslice tick.
      if (recorder !== newRecorder || !event.data || event.data.size === 0) return;
      sendChunk(segmentId, event.data, false);
    };
    newRecorder.onerror = (event) => {
      if (recorder !== newRecorder) return;
      recorder = null;
      currentSegmentId = null;
      reportCurrentStatus({
        state: 'failed',
        reason: event && event.error && event.error.message ? event.error.message : 'MediaRecorder error',
      });
    };

    newRecorder.start(recordingTimesliceMs);
  }

  async function startRecording(sessionId, segmentId, timesliceMs) {
    if (!stream) {
      reportStatus(sessionId, { state: 'failed', reason: 'no active capture stream to record' });
      return;
    }

    const mimeType = RECORDING_MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) {
      reportStatus(sessionId, { state: 'failed', reason: 'no supported MediaRecorder mime type on this platform' });
      return;
    }

    recordingMimeType = mimeType;
    recordingTimesliceMs = timesliceMs;
    currentRecordingSession = sessionId;
    createRecorder(segmentId);
    reportStatus(sessionId, { state: 'started', mimeType });
  }

  /**
   * Finishes the outgoing segment and begins the next one. Deliberately a
   * stop *and* a fresh start rather than trying to keep one MediaRecorder
   * running and split its output at a cluster boundary: a fresh start() is
   * what emits a new container header, which is what makes each segment
   * file independently playable on its own -- splitting mid-container would
   * need a remuxer, and this repo has zero runtime dependencies to build one
   * from. Main -- not a timer in here -- decides when to roll, since only it
   * knows the byte count each segment has reached (it's the one writing
   * segments to disk); this file just carries out the roll it's told to do.
   */
  async function rollRecording(sessionId, nextSegmentId) {
    if (sessionId !== currentRecordingSession) return;
    await stopCurrentRecorder(); // sends the outgoing segment's final chunk, last: true
    if (sessionId !== currentRecordingSession) return; // superseded while flushing
    createRecorder(nextSegmentId);
    reportStatus(sessionId, { state: 'rolled', segmentId: nextSegmentId });
  }

  async function stopRecording(sessionId) {
    await stopCurrentRecorder(); // sends the final chunk, last: true

    // Only tear down the shared module state if this stop still owns it.
    // `stopCurrentRecorder()` above awaits a real `dataavailable`/`onstop`
    // pair, which can outlast main's bounded wait for `stopped` -- and once
    // main gives up it is free to start a *new* session, which writes these
    // same globals. Clearing them unconditionally here would null out the new
    // session's mime type and timeslice from inside the old session's
    // teardown (review). The `stopped` below is still reported either way, but
    // tagged with this session, so main drops it unless it is still the one
    // waiting.
    if (sessionId === currentRecordingSession) {
      recordingMimeType = null;
      recordingTimesliceMs = null;
      currentRecordingSession = null;
    }
    reportStatus(sessionId, { state: 'stopped' });
  }

  window.captureHost.onOpen((sourceId) => {
    openSession(sourceId).catch((error) => {
      console.error('screen-solver capture: failed to open session', error);
    });
  });

  window.captureHost.onClose(() => {
    closeSession().catch((error) => {
      console.error('screen-solver capture: failed to close session', error);
    });
  });

  window.captureHost.onRequestFrame(() => captureFrame());

  window.screenRecordingHost.onStart((sessionId, segmentId, timesliceMs) => {
    startRecording(sessionId, segmentId, timesliceMs).catch((error) => {
      reportStatus(sessionId, {
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  });

  window.screenRecordingHost.onRoll((sessionId, nextSegmentId) => {
    rollRecording(sessionId, nextSegmentId).catch((error) => {
      reportStatus(sessionId, {
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  });

  window.screenRecordingHost.onStop((sessionId) => {
    stopRecording(sessionId).catch((error) => {
      console.error('screen-solver recording: failed to stop cleanly', error);
      reportStatus(sessionId, { state: 'stopped' });
    });
  });
})();
