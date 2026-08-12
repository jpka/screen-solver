// The PCM writer that runs on the audio rendering thread (not the main
// renderer thread). Plain JavaScript on purpose: `static/` is loaded as-is,
// never compiled (see AGENTS.md).
//
// Loaded by audio.js via `ctx.audioWorklet.addModule('pcm-worklet.js')`, which
// the page's CSP gates behind `worker-src` (see index.html). This file runs in
// the AudioWorkletGlobalScope -- no DOM, no `window`, no access to anything
// audio.js has. Its entire job is format conversion: the Web Audio graph deals
// in Float32 quanta of 128 frames, and Deepgram is told to expect `linear16`
// at 16 kHz, so something has to turn one into the other. That something is
// here rather than in audio.js because the conversion has to happen on every
// quantum, and shipping 128-frame Float32 arrays to the main thread 375 times
// a second to convert them there would be absurd.
//
// No resampling happens here or anywhere else: audio.js runs its AudioContext
// at 16 kHz, and Chromium resamples the 48 kHz device stream into the context's
// rate for free.

/** 1600 frames = 100 ms at 16 kHz = 3200 bytes on the wire. */
const FRAMES_PER_MESSAGE = 1600;

class Pcm16Writer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Int16Array(FRAMES_PER_MESSAGE);
    this.filled = 0;
  }

  process(inputs) {
    // A disconnected or not-yet-flowing input gives an empty `inputs[0]` (or
    // an `inputs[0]` with no channels). Returning true keeps this processor
    // alive so it starts producing the moment audio does arrive; throwing --
    // or returning false -- would kill the node for the rest of the session
    // over what is a normal transient.
    const samples = inputs[0]?.[0];
    if (samples === undefined) return true;

    for (let i = 0; i < samples.length; i += 1) {
      // Float32 audio is nominally [-1, 1] but is not guaranteed to be:
      // anything upstream can overshoot, and an unclamped overshoot wraps
      // around in Int16 into a loud click rather than clipping quietly.
      const sample = Math.max(-1, Math.min(1, samples[i]));
      // Asymmetric scaling because two's complement is asymmetric: -1.0 maps
      // to -32768 and +1.0 to +32767, so neither end wraps.
      // `Int16Array` writes in the platform's byte order, which is
      // little-endian everywhere Electron runs -- exactly the `linear16` the
      // Deepgram query string declares.
      this.pending[this.filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.filled += 1;

      if (this.filled === FRAMES_PER_MESSAGE) {
        const buffer = this.pending.buffer;
        // Transferred, not copied -- and transferring detaches it, which is
        // why the next block gets a freshly allocated array rather than
        // reusing this one.
        this.port.postMessage(buffer, [buffer]);
        this.pending = new Int16Array(FRAMES_PER_MESSAGE);
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm16-writer', Pcm16Writer);
