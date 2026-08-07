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

  function stopStream() {
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
    stopStream();

    // getUserMedia's legacy `mandatory` constraint syntax is what Electron's
    // desktopCapturer integration actually requires; there is no standard
    // MediaTrackConstraints shape for "capture this specific window".
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        },
      },
    });

    videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.srcObject = stream;
    await videoEl.play();
  }

  function closeSession() {
    stopStream();
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

  window.captureHost.onOpen((sourceId) => {
    openSession(sourceId).catch((error) => {
      console.error('screen-solver capture: failed to open session', error);
    });
  });

  window.captureHost.onClose(() => {
    closeSession();
  });

  window.captureHost.onRequestFrame(() => captureFrame());
})();
