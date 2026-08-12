// The hidden renderer's loopback-audio mechanism, the recording pipeline's
// twin of capture.js. Plain JavaScript on purpose: `static/` is loaded/served
// as-is, never compiled or transpiled (see AGENTS.md).
//
// No decision logic belongs in this file. Whether to record at all, what to do
// with a chunk, how to survive a dropped socket, and what a failure means to
// the user all live in src/host/audio/, run from main. This file only does
// mechanism: turn the Windows render loopback into a live MediaStream via
// getDisplayMedia, run it through an AudioWorklet that emits 16 kHz signed-16
// PCM, and hand each ~100 ms block to main over the IPC surface preload.js
// exposes as `window.audioHost`.
(() => {
  'use strict';

  // The one channel this app records today: the PC's render loopback --
  // whatever the speakers are playing. `TranscriptChannel` in
  // src/host/audio/types.ts reserves 'me' for a future microphone; nothing
  // here implements it, deliberately.
  const CHANNEL = 'them';

  // The AudioContext runs at Deepgram's declared input rate rather than the
  // device's. Chromium resamples the (typically 48 kHz) loopback stream into
  // the context's rate as part of connecting the MediaStreamSource, which is
  // why there is no resampler anywhere in this codebase -- not here, not in
  // pcm-worklet.js, not in src/host/audio/.
  const SAMPLE_RATE = 16000;

  // A video track is mandatory. `getDisplayMedia({ audio: true, video: false })`
  // throws NotSupportedError in Electron -- loopback audio is only reachable
  // through a display-media request, and a display-media request without video
  // isn't one. The track is stopped and removed the instant the stream
  // arrives (the audio track keeps running fine without it), so these
  // dimensions only have to survive a few milliseconds -- but they must be
  // non-zero: a 0px video track trips a SharedImage -> VideoFrame error inside
  // Chromium that takes the audio track down with it (electron#49607), so 2x2
  // at 1 fps is the smallest thing that reliably works rather than an
  // arbitrary "small".
  const DISPLAY_MEDIA_CONSTRAINTS = {
    video: { width: { ideal: 2 }, height: { ideal: 2 }, frameRate: { ideal: 1 } },
    audio: true,
  };

  /**
   * Everything one running session owns, or null when nothing is running.
   * @type {{ctx: AudioContext, stream: MediaStream, source: MediaStreamAudioSourceNode, worklet: AudioWorkletNode, sink: GainNode}|null}
   */
  let session = null;

  // Bumped by every start/stop request. `startCapture` is async in several
  // places (resume, addModule, getDisplayMedia), so a `stop` -- or a newer
  // `start` -- can arrive from main while a previous start is still in flight.
  // Without this guard that stop would find nothing to tear down, and the
  // in-flight start would then finish and light up a live loopback stream
  // (and the OS recording indicator) for a session everyone believes is
  // closed. Exactly capture.js's `sessionToken`, for exactly its reason.
  let sessionToken = 0;

  function teardownSession() {
    if (!session) return;
    const open = session;
    session = null;

    open.worklet.port.onmessage = null;
    open.source.disconnect();
    open.worklet.disconnect();
    open.sink.disconnect();
    for (const track of open.stream.getTracks()) track.stop();
    // Not awaited (nothing upstream waits for a teardown), so its rejection
    // has to be swallowed here or it surfaces as an unhandled rejection in a
    // renderer nobody is watching.
    open.ctx.close().catch(() => {});
  }

  /** Drops a partially-built session's resources without touching `session`. */
  async function discard(ctx, stream) {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (ctx) {
      await ctx.close().catch(() => {});
    }
  }

  async function startCapture() {
    const token = (sessionToken += 1);
    teardownSession();

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    /** @type {MediaStream|null} */
    let stream = null;

    try {
      // A hidden window never receives a user gesture, so its AudioContext is
      // created suspended and stays that way unless resumed explicitly --
      // which Chromium only permits because hidden-window.ts sets
      // `autoplayPolicy: 'no-user-gesture-required'`. A suspended context
      // never pulls the graph, so this is one of the two ways this pipeline
      // can be perfectly wired and produce nothing at all.
      await ctx.resume();
      await ctx.audioWorklet.addModule('pcm-worklet.js');

      stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_CONSTRAINTS);
      // Drop the mandatory video track immediately: nothing wants desktop
      // frames here, and leaving one running would keep a screen capture
      // alive (and its indicator lit) for a feature that only listens.
      // Verified on Electron 43 / Windows 11: the audio track stays `live`.
      for (const track of stream.getVideoTracks()) {
        track.stop();
        stream.removeTrack(track);
      }

      if (token !== sessionToken) {
        // Superseded while the grab was in flight -- tear down what was just
        // built instead of adopting it, and stay quiet: whoever superseded
        // this start is the one reporting status now.
        await discard(ctx, stream);
        return;
      }

      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'pcm16-writer');

      // THE ZERO-GAIN NODE IS LOAD-BEARING. Web Audio is pull-based: a node
      // is only processed if it is (transitively) connected to the context's
      // destination. A worklet whose output goes nowhere is never pulled, so
      // its `process()` is never called and not one byte of PCM is ever
      // produced -- with no error, no warning, and a graph that looks
      // completely correct. Connecting through a gain of 0 keeps the worklet
      // in the destination's pull path while sending literal silence to the
      // speakers, so the user hears nothing extra and never hears the meeting
      // echoed back. This is the single most likely silent-failure mode in
      // this file: do not "simplify" it away.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(worklet).connect(sink).connect(ctx.destination);

      worklet.port.onmessage = (event) => {
        if (token !== sessionToken) return;
        // event.data is a plain ArrayBuffer, transferred out of the worklet.
        // It crosses to main as an ArrayBuffer too, not base64 and not a
        // typed-array view -- see src/main/audio-ipc-channels.ts for why that
        // is the right call here and base64 was the right call for frames.
        window.audioHost.sendChunk(CHANNEL, event.data);
      };

      session = { ctx, stream, source, worklet, sink };
      window.audioHost.reportStatus('started');
    } catch (error) {
      await discard(ctx, stream);
      if (token !== sessionToken) return; // superseded; the newer request owns the status
      window.audioHost.reportStatus(
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function stopCapture() {
    sessionToken += 1;
    teardownSession();
  }

  window.audioHost.onStart(() => {
    // `startCapture` reports its own failures over the status channel; this
    // catch only exists so a bug in that reporting can't become an unhandled
    // rejection in the hidden renderer, where nobody would ever see it.
    startCapture().catch((error) => {
      console.error('screen-solver audio: failed to start capture', error);
    });
  });

  window.audioHost.onStop(() => {
    stopCapture();
  });
})();
