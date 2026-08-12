import type { ServerResponse } from 'node:http';
import type { TargetWindowIdentity } from '../config/types.ts';
import type { ProviderErrorKind, Usage } from '../provider/types.ts';
import type { RecordingSnapshot } from '../recording/coordinator.ts';
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
 * `recording{state,segmentId,bytes,startedAt,reason}` (#45) is the recorder's
 * live state. It rides this same channel for the reason `status` already does
 * -- the spec ruled out a second push endpoint -- and is replayed on
 * `subscribe()` whenever the state isn't `off`, the same catch-up `sync` and
 * `status` use. It is broadcast both on real state changes *and* once per
 * second while recording, because `bytes` is a live counter: a client that only
 * learned the byte total at a segment boundary would show a frozen number for
 * minutes at a time. That makes it the one deliberately chatty event here, and
 * it stays cheap because it is a single small frame to a handful of local
 * clients.
 */
export type SseEvent =
  | { readonly type: 'start' }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly usage: Usage }
  | { readonly type: 'error'; readonly kind: ProviderErrorKind }
  | { readonly type: 'sync'; readonly text: string }
  | { readonly type: 'status'; readonly level: StatusSnapshot['level']; readonly kind: StatusSnapshot['kind'] }
  | { readonly type: 'config'; readonly target: TargetWindowIdentity | null; readonly revision: number }
  | ({ readonly type: 'recording' } & RecordingSnapshot);

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
   * Broadcasts the recorder's current state (#45) -- `bootstrap.ts` wires this
   * to `RecordingCoordinator`'s `onStateChange`. Unlike `status`, no
   * change-filtering happens here: the coordinator deliberately republishes on
   * a timer so the client's byte counter advances, and deciding what is worth
   * sending is its job, not this broadcaster's.
   */
  recording(snapshot: RecordingSnapshot): void;
  /** The recorder's last published state -- `subscribe()` replays it when it isn't `off`, and `GET /recording` serves it. */
  currentRecording(): RecordingSnapshot;
}

/** What a client is told before any recorder has ever reported in. */
const IDLE_RECORDING: RecordingSnapshot = Object.freeze({
  state: 'off',
  segmentId: null,
  bytes: 0,
  startedAt: null,
  reason: null,
});

export function createEventBroadcaster(): EventBroadcaster {
  const clients = new Set<ServerResponse>();
  let text = '';
  let inFlight = false;
  let status: StatusSnapshot = { level: 'silent', kind: null };
  let configRevision = 0;
  let recording: RecordingSnapshot = IDLE_RECORDING;

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

      if (recording.state !== 'off') {
        // Same one-client catch-up as `sync` and `status`. A client opening
        // mid-recording has to learn that immediately -- a REC indicator that
        // only appeared after the next state change would leave a phone showing
        // "not recording" while the desktop was, in fact, recording, which is
        // the one thing this feature must never do.
        try {
          res.write(frameFor({ type: 'recording', ...recording }));
        } catch {
          clients.delete(res);
        }
      }

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

    recording(snapshot) {
      recording = snapshot;
      broadcast({ type: 'recording', ...snapshot });
    },

    currentRecording: () => recording,
  };
}

function frameFor(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
