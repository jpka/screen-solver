/**
 * The audio/transcription seam's public vocabulary.
 *
 * Shaped after the capture seam (`capture/types.ts`) and the provider seam
 * (`provider/types.ts`): small explicit unions and interfaces, no classes, and
 * every OS- or network-touching capability declared here as an injected
 * function type so the decision logic in this directory is testable in plain
 * Node with no Electron and no socket.
 *
 * The mechanism these types wrap lives in two places nothing here imports:
 * `src/main/audio-capture.ts` + `static/renderer/audio.js` turn Windows
 * render-loopback into PCM, and `deepgram-transport.ts` turns a WebSocket into
 * messages. Everything else in `src/host/audio/` is decisions.
 */

/**
 * Which independently-captured stream a piece of audio came from.
 *
 * Speaker attribution here is *structural*, not inferred: the socket a chunk
 * was sent on is the identity, so no diarization is involved and no
 * `channel_index` has to be trusted. `'them'` is the PC's render-loopback --
 * whatever the speakers are playing. `'me'` is the PC's own microphone.
 *
 * Only `'them'` is ever produced today: the first cut deliberately records
 * loopback only, which halves the per-minute Deepgram bill and sidesteps
 * needing echo cancellation to stop speaker output being transcribed a second
 * time on the mic channel. `'me'` ships in the vocabulary and on every
 * persisted line anyway so that turning the microphone on later is purely
 * additive -- a new producer and a second stream -- rather than a migration of
 * every `transcript.jsonl` line already on disk. It is a reserved value, not
 * dead code.
 */
export type TranscriptChannel = 'them' | 'me';

/**
 * One block of 16 kHz mono signed-16-bit little-endian PCM, ~100 ms long.
 *
 * `linear16` at 16 kHz is what the Deepgram query string declares, and the
 * renderer produces it directly by running its `AudioContext` at that rate --
 * Chromium resamples the 48 kHz device stream for free, so there is no
 * resampler anywhere in this codebase.
 */
export interface AudioChunk {
  readonly channel: TranscriptChannel;
  readonly pcm: Uint8Array;
}

export type AudioChunkSink = (chunk: AudioChunk) => void;

/**
 * Opens live audio capture, pushing every chunk to `sink` until closed.
 *
 * `src/main/audio-capture.ts` supplies the real implementation (Electron's
 * `setDisplayMediaRequestHandler` with `audio: 'loopback'`, an `AudioWorklet`
 * in the hidden renderer, chunks over IPC); tests supply a fake that pushes
 * canned chunks. Same seam shape as `OpenCaptureSession` in
 * `capture/types.ts`, and for the same reason.
 *
 * Push-based rather than pull-based, unlike `CaptureSession.captureFrame()`:
 * audio arrives on the device's clock whether anyone asked for it or not, and
 * a puller that fell behind would have to decide what to drop. The sink
 * pushes into a bounded buffer inside the transcriber, which is the one place
 * that decision belongs.
 */
export type OpenAudioCapture = (sink: AudioChunkSink) => Promise<AudioCapture>;

export interface AudioCapture {
  close(): Promise<void>;
}

/**
 * The ways transcription can fail, mirroring `ProviderErrorKind`.
 *
 * `audio-rejected` is Deepgram's close code 1008 / `DATA-0000`: the bytes we
 * sent could not be decoded as audio under the encoding parameters we
 * declared. That is a bug in this app, not a flaky moment, so it is never
 * retried -- the same judgment `anthropic.ts` makes about a 400.
 */
export type TranscriberErrorKind = 'auth' | 'transient' | 'audio-rejected';

/**
 * What a live transcription stream reports.
 *
 * `interim` text is unstable by definition: Deepgram revises it, and a later
 * message supersedes it wholesale rather than appending to it. Only `final`
 * is ever persisted or fed to the model.
 */
export type TranscriptEvent =
  | { readonly type: 'interim'; readonly text: string }
  | {
      readonly type: 'final';
      readonly text: string;
      /** Seconds from the start of *this socket's* audio -- see `TranscriptEntry`. */
      readonly startSeconds: number;
      readonly endSeconds: number;
    }
  | { readonly type: 'reconnecting'; readonly attempt: number }
  | { readonly type: 'open' }
  | { readonly type: 'error'; readonly kind: TranscriberErrorKind; readonly message: string };

export interface TranscriberStreamOptions {
  readonly channel: TranscriptChannel;
  readonly onEvent: (event: TranscriptEvent) => void;
}

export interface TranscriberStream {
  /**
   * Queues one chunk. Never throws and never blocks: while a reconnect is in
   * flight the bytes go into a bounded buffer instead of the socket, and the
   * caller -- which is an audio device callback -- must not be made to care
   * which of those is happening.
   */
  send(pcm: Uint8Array): void;
  /**
   * Asks the provider to flush whatever it is still holding, waits a bounded
   * moment for the trailing finals, then closes regardless. The bound is
   * internal on purpose: shutdown composes several of these inside one
   * already-bounded drain phase (`bootstrap.ts`), and a close that could hang
   * would eat that whole budget.
   */
  close(): Promise<void>;
}

/**
 * The transcription seam.
 *
 * Callback-shaped rather than async-iterable, deliberately unlike
 * `Provider.solve`: a solve is request/response and ends, so a generator that
 * returns is the natural shape for it. A transcriber is a long-lived
 * subscription with no natural end, driven by a socket that reconnects
 * underneath the caller -- which is the shape `ConfigStore.onChange` and
 * `EventBroadcaster` already use here.
 */
export interface Transcriber {
  /** Recorded on every `transcript.jsonl` line, mirroring `Provider.model`. */
  readonly model: string;
  open(options: TranscriberStreamOptions): TranscriberStream;
}
