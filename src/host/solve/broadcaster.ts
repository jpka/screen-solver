import type { ServerResponse } from 'node:http';
import type { ProviderErrorKind, Usage } from '../provider/types.ts';
import type { StatusSnapshot } from './status.ts';

/**
 * The SSE wire vocabulary: the spec's full vocabulary minus `config{target}`,
 * which already has its own home on `ConfigStore.onChange` (#28) and isn't
 * this broadcaster's job. `sync{text}` (#31) is sent only to one
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
 */
export type SseEvent =
  | { readonly type: 'start' }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly usage: Usage }
  | { readonly type: 'error'; readonly kind: ProviderErrorKind }
  | { readonly type: 'sync'; readonly text: string }
  | { readonly type: 'status'; readonly level: StatusSnapshot['level']; readonly kind: StatusSnapshot['kind'] };

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
}

export function createEventBroadcaster(): EventBroadcaster {
  const clients = new Set<ServerResponse>();
  let text = '';
  let inFlight = false;
  let status: StatusSnapshot = { level: 'silent', kind: null };

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
  };
}

function frameFor(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
