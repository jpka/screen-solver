import type { ServerResponse } from 'node:http';
import type { RecordingState } from '../audio/recording-coordinator.ts';
import type { TranscriptChannel } from '../audio/types.ts';
import type { TargetWindowIdentity } from '../config/types.ts';
import type { TranscriptEntry } from '../logs/types.ts';
import type { ProviderErrorKind, Usage } from '../provider/types.ts';
import type { StatusSnapshot } from './status.ts';

/**
 * The SSE wire vocabulary. `sync{text}` (#31) is sent only to one
 * newly-subscribing client mid-flight, in place of `start` -- see
 * {@link EventBroadcaster.subscribe}.
 *
 * `status{level,kind}` (#32) is the standing status pill's wire home -- the
 * spec calls for "a standing status indicator... over the existing SSE
 * channel" (story 38) rather than a separate push/toast mechanism, so it
 * rides this same broadcast the way every other event here does, not a new
 * endpoint. Broadcast only on an actual level change (`status.ts`'s own
 * `onOutcome` already suppresses no-op transitions), and replayed to a
 * newly-subscribing client whenever it isn't `silent`, the same "catch this
 * one connecting client up" idea `sync` already uses -- see
 * {@link EventBroadcaster.subscribe}.
 *
 * `config{target,revision}` (#33) mirrors `ConfigStore.onChange` (#28) onto
 * the wire, so the client (#33) can react live to a target change -- a fresh
 * pick from the picker, or #32's own mid-run fallback to `null` -- without a
 * reload. Unlike `sync`/`status`, `subscribe()` never replays this on
 * connect: a freshly-connecting client already gets the current target from
 * a plain `GET /config`, so there is nothing "in flight" here for a catch-up
 * frame to backfill.
 *
 * `revision` exists because a client has *two* independent, unordered
 * sources for the target -- this SSE event and its own `GET /config`
 * fetch -- and network delivery order between them says nothing about which
 * one is actually more current (review feedback on #33's PR: a client that
 * simply trusted "whichever arrived first" could permanently strand itself
 * on a stale target if a slow-to-arrive `GET /config` response happened to
 * describe a *later* change than an SSE frame the client had already
 * applied). A monotonically increasing counter, bumped on every `config()`
 * call and handed back by both `GET /config` (`routes.ts`) and this event,
 * gives the client real ordering to compare against instead of guessing from
 * arrival order.
 *
 * `transcript{entry}`, `transcript-interim{channel,text}` and
 * `recording{state,revision}` are the audio feature's wire home, and they ride
 * this same broadcast for exactly the reason `status` does -- the transcript
 * pane is another view of the one shared, unfiltered, unauthenticated stream,
 * not a second channel with its own connection lifecycle.
 *
 * The split between the two transcript events is the interim/final split
 * Deepgram itself draws. A `final` is immutable and is what
 * `transcript.jsonl` records, so `transcript` frames only ever append. An
 * interim is revised wholesale by the next one, so `transcript-interim`
 * *replaces* the pending line for its channel rather than adding to it --
 * which is why it carries `channel` as its own field instead of a whole
 * entry: there is nothing durable to describe yet.
 *
 * `recording` reuses the `config` revision idea for the identical reason: a
 * client learns the recording state from two unordered sources (this frame and
 * its own `GET /recording`), and arrival order says nothing about which is
 * more current. Its own counter, not `config`'s -- recording state is
 * deliberately not part of the persisted config, and one counter serving two
 * unrelated things would make both of them lie.
 */
export type SseEvent =
  | { readonly type: 'start' }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly usage: Usage }
  | { readonly type: 'error'; readonly kind: ProviderErrorKind }
  | { readonly type: 'sync'; readonly text: string }
  | { readonly type: 'status'; readonly level: StatusSnapshot['level']; readonly kind: StatusSnapshot['kind'] }
  | { readonly type: 'config'; readonly target: TargetWindowIdentity | null; readonly revision: number }
  | { readonly type: 'transcript'; readonly entry: TranscriptEntry }
  | { readonly type: 'transcript-interim'; readonly channel: TranscriptChannel; readonly text: string }
  | { readonly type: 'recording'; readonly state: RecordingState; readonly revision: number };

/**
 * One shared broadcast to every connected `GET /events` client -- no
 * per-client filtering, no auth, exactly per the spec. `router.ts` hands a
 * streaming route handler the raw `res`; {@link EventBroadcaster.subscribe}
 * is what hijacks it for SSE "without fighting the router".
 */
export interface EventBroadcaster {
  /**
   * Writes SSE headers, registers `res` as a client, and returns an
   * unsubscribe function. The caller (the `GET /events` route handler) wires
   * that to the request's `close` event.
   *
   * If a solve is currently in flight (`start()` has fired with no terminal
   * `done`/`error` since), this one connecting client is sent `sync{text}`
   * -- the accumulated text so far -- instead of silently waiting for the
   * next `start`. A client connecting with nothing in flight gets no extra
   * frame at all; it simply waits for the next real `start`, same as before
   * this ticket. `EventSource`'s own reconnect (after a network blip, e.g. a
   * phone lock/unlock) hits this exact path too -- a reconnect is treated
   * identically to a fresh mid-flight join, per spec, so no separate
   * `Last-Event-ID` replay logic exists.
   */
  subscribe(res: ServerResponse): () => void;
  /** Starts a fresh solve: resets the in-memory accumulated text, marks a solve in flight, then broadcasts `start`. */
  start(): void;
  /** Appends to the in-memory accumulated text, then broadcasts `delta`. */
  delta(text: string): void;
  /** Broadcasts the terminal `done`, marking nothing in flight. Does not touch the accumulated text -- it stays readable via {@link currentText} until the next `start()`. */
  done(usage: Usage): void;
  /** Broadcasts the terminal `error`, marking nothing in flight. */
  error(kind: ProviderErrorKind): void;
  /**
   * The in-memory accumulated text of whatever solve is currently in flight
   * (or just finished) -- reset on the next `start()`. This is the "server
   * holds the in-flight accumulated answer text in memory" the issue calls
   * for; `subscribe()` reads this directly to build a `sync{text}` catch-up
   * for a late-joining client.
   */
  currentText(): string;
  /**
   * Records the standing status pill's new reading and broadcasts `status`
   * (#32) -- `loop.ts` calls this with whatever `status.ts`'s `StatusTracker`
   * hands back, which is already `null`-filtered down to real level changes
   * only.
   */
  status(snapshot: StatusSnapshot): void;
  /** The pill's current reading -- `subscribe()` reads this to catch up a newly-connecting client; `silent` is the default and is never itself replayed (nothing to catch up on). */
  currentStatus(): StatusSnapshot;
  /**
   * Broadcasts a target-window change (#33) -- `routes.ts` wires this to
   * `ConfigStore.onChange` whenever a `configStore` is supplied. Assigns and
   * broadcasts the next revision number; no corresponding catch-up on
   * `subscribe()`: see the `config{target,revision}` doc comment on
   * {@link SseEvent} for why.
   */
  config(target: TargetWindowIdentity | null): void;
  /**
   * The revision last broadcast by {@link config} (`0` if `config()` has
   * never been called) -- `routes.ts`'s `GET /config` hands this back
   * alongside the current target, so a client can tell whether that
   * snapshot is newer or older than whatever `config` SSE frame it may have
   * already applied. See the `revision` doc comment on {@link SseEvent}.
   */
  currentConfigRevision(): number;
  /**
   * Broadcasts one finalized transcript segment -- the same entry
   * `transcript.jsonl` just received. Append-only on the client: a final is
   * never revised.
   */
  transcript(entry: TranscriptEntry): void;
  /**
   * Broadcasts the current in-progress line for one channel, replacing
   * whatever that channel's pending line was. Never persisted, and never
   * fed to the model -- interim text is unstable by definition.
   */
  transcriptInterim(channel: TranscriptChannel, text: string): void;
  /** The pending interim line per channel -- `subscribe()` replays these so a client that connects mid-sentence isn't staring at a blank pane. */
  currentInterim(): ReadonlyMap<TranscriptChannel, string>;
  /** Records the recording lifecycle's new state, assigns the next revision, and broadcasts it. */
  recording(state: RecordingState): void;
  recordingSnapshot(): { readonly state: RecordingState; readonly revision: number };
}

export function createEventBroadcaster(): EventBroadcaster {
  const clients = new Set<ServerResponse>();
  let text = '';
  let inFlight = false;
  let status: StatusSnapshot = { level: 'silent', kind: null };
  let configRevision = 0;
  let recordingState: RecordingState = 'off';
  let recordingRevision = 0;
  const interim = new Map<TranscriptChannel, string>();

  function broadcast(event: SseEvent): void {
    const frame = frameFor(event);
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        // A client that's gone (socket reset, etc.) is simply dropped -- the
        // request's own `close` handler unsubscribes it too, but a write can
        // race ahead of that event firing.
        clients.delete(client);
      }
    }
  }

  return {
    subscribe(res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      // A leading comment frame flushes the headers immediately, so a client
      // observes the connection as open before the first real event -- and so
      // a test awaiting the `fetch()` response knows subscription has already
      // happened, not just been requested.
      res.write(':ok\n\n');
      clients.add(res);

      if (inFlight) {
        // Sent to this one connecting client only -- not a `broadcast()`,
        // since every other already-subscribed client has no use for a
        // catch-up it doesn't need.
        try {
          res.write(frameFor({ type: 'sync', text }));
        } catch {
          clients.delete(res);
        }
      }

      if (status.level !== 'silent') {
        // Same "catch this one client up" idea as `sync` above, for the
        // status pill: a client that opens for the first time during an
        // ongoing `sticky`/`auto-recovering` episode learns about it
        // immediately, rather than only on the *next* failure -- "the pill
        // only speaks to whichever client is currently open" (spec) still
        // holds, since this only ever reaches the one client asking.
        try {
          res.write(frameFor({ type: 'status', level: status.level, kind: status.kind }));
        } catch {
          clients.delete(res);
        }
      }

      if (recordingState !== 'off') {
        // The same "catch this one client up" idea as `sync` and `status`: a
        // phone that unlocks mid-meeting must learn that recording is already
        // live, rather than showing an Off toggle over a running session and
        // inviting the user to "start" what is already started. `off` is the
        // default and carries nothing to catch up on, exactly as `silent` does
        // for the status pill.
        try {
          res.write(frameFor({ type: 'recording', state: recordingState, revision: recordingRevision }));
        } catch {
          clients.delete(res);
        }
      }

      for (const [channel, text] of interim) {
        // Without this a client connecting mid-sentence sees nothing at all
        // until the speaker finishes the sentence they are already saying.
        try {
          res.write(frameFor({ type: 'transcript-interim', channel, text }));
        } catch {
          clients.delete(res);
        }
      }

      // Finalized transcript lines are deliberately *not* replayed: `GET
      // /transcript` already answers "what was said", and replaying an
      // unbounded backlog down the event stream would duplicate it. The same
      // argument `config` makes about `GET /config`.

      return () => {
        clients.delete(res);
      };
    },

    start() {
      text = '';
      inFlight = true;
      broadcast({ type: 'start' });
    },

    delta(deltaText) {
      text += deltaText;
      broadcast({ type: 'delta', text: deltaText });
    },

    done(usage) {
      inFlight = false;
      broadcast({ type: 'done', usage });
    },

    error(kind) {
      inFlight = false;
      broadcast({ type: 'error', kind });
    },

    currentText: () => text,

    status(snapshot) {
      status = snapshot;
      broadcast({ type: 'status', level: snapshot.level, kind: snapshot.kind });
    },

    currentStatus: () => status,

    config(target) {
      configRevision += 1;
      broadcast({ type: 'config', target, revision: configRevision });
    },

    currentConfigRevision: () => configRevision,

    transcript(entry) {
      // A final ends whatever interim line was pending for that channel: the
      // sentence it was guessing at is now settled and has moved to the list.
      interim.delete(entry.channel);
      broadcast({ type: 'transcript', entry });
    },

    transcriptInterim(channel, text) {
      interim.set(channel, text);
      broadcast({ type: 'transcript-interim', channel, text });
    },

    currentInterim: () => interim,

    recording(state) {
      recordingState = state;
      recordingRevision += 1;
      if (state === 'off') {
        // Nothing is being transcribed any more, so a pending guess must not
        // be replayed to the next client as though it still were.
        interim.clear();
      }
      broadcast({ type: 'recording', state, revision: recordingRevision });
    },

    recordingSnapshot: () => ({ state: recordingState, revision: recordingRevision }),
  };
}

function frameFor(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
