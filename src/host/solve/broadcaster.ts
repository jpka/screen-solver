import type { ServerResponse } from 'node:http';
import type { ProviderErrorKind, Usage } from '../provider/types.ts';

/**
 * The SSE wire vocabulary this ticket implements: the spec's full vocabulary
 * (`start`, `delta`, `done`, `error`, `sync`, `config`) minus `sync` (#31's
 * mid-flight-join catch-up -- this ticket only has to keep the accumulated
 * text somewhere `EventBroadcaster.currentText()` can reach, per the issue
 * body) and `config{target}`, which already has its own home on
 * `ConfigStore.onChange` (#28) and isn't this broadcaster's job.
 */
export type SseEvent =
  | { readonly type: 'start' }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly usage: Usage }
  | { readonly type: 'error'; readonly kind: ProviderErrorKind };

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
   */
  subscribe(res: ServerResponse): () => void;
  /** Starts a fresh solve: resets the in-memory accumulated text, then broadcasts `start`. */
  start(): void;
  /** Appends to the in-memory accumulated text, then broadcasts `delta`. */
  delta(text: string): void;
  /** Broadcasts the terminal `done`. Does not touch the accumulated text -- it stays readable via {@link currentText} until the next `start()`. */
  done(usage: Usage): void;
  /** Broadcasts the terminal `error`. */
  error(kind: ProviderErrorKind): void;
  /**
   * The in-memory accumulated text of whatever solve is currently in flight
   * (or just finished) -- reset on the next `start()`. This is the "server
   * holds the in-flight accumulated answer text in memory" the issue calls
   * for; #31 reads this directly to build a `sync{text}` catch-up for a
   * late-joining client. Nothing in this ticket implements that catch-up.
   */
  currentText(): string;
}

export function createEventBroadcaster(): EventBroadcaster {
  const clients = new Set<ServerResponse>();
  let text = '';

  function broadcast(event: SseEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
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
      return () => {
        clients.delete(res);
      };
    },

    start() {
      text = '';
      broadcast({ type: 'start' });
    },

    delta(deltaText) {
      text += deltaText;
      broadcast({ type: 'delta', text: deltaText });
    },

    done(usage) {
      broadcast({ type: 'done', usage });
    },

    error(kind) {
      broadcast({ type: 'error', kind });
    },

    currentText: () => text,
  };
}
