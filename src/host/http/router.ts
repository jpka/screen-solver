import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Logger } from '../logger.ts';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

export interface Route {
  readonly method: string;
  /** Exact pathname match. The v1 HTTP surface has no path parameters. */
  readonly path: string;
  readonly handle: RouteHandler;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Every request body this HTTP surface's JSON routes ever legitimately need
 * is a couple of short strings (`POST /config/target`'s `{processName,
 * title}`) -- 64 KiB is generously past that, with headroom, while still
 * bounding how much a single request can force this process to hold in
 * memory before it's even been validated.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/** Thrown by {@link readJsonBody} when a request body exceeds {@link MAX_JSON_BODY_BYTES}. A distinct type so callers can answer `413` instead of the generic `400` a parse failure gets. */
export class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit.`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Buffers a request body and parses it as JSON -- the one thing the router
 * itself has no built-in support for, since `POST /solve` (#29) never needed
 * one. `POST /config/target` (#33) is the first route that does.
 *
 * An empty body parses as `null` rather than rejecting, so a client can
 * `POST` with no body at all to mean "no target" without also having to send
 * a literal `null` JSON payload. Malformed JSON rejects with the parse
 * error; the caller decides how that becomes a `400`.
 *
 * Rejects with {@link PayloadTooLargeError} -- and stops reading, destroying
 * the connection rather than draining it -- the moment accumulated bytes
 * cross `maxBytes` (review feedback on #33's PR: the original version had no
 * bound at all, so any client with network access could hand this an
 * unbounded or endlessly-streamed body and exhaust process memory before
 * validation ever ran).
 */
export function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      fn();
    };

    function onData(chunk: Buffer): void {
      received += chunk.length;
      if (received > maxBytes) {
        settle(() => reject(new PayloadTooLargeError(maxBytes)));
        // Not `req.destroy()`: destroying the socket mid-write races the
        // still-in-progress request body against the connection dying, and
        // a client can observe that as a raw `ECONNRESET` instead of the
        // `413` response the caller is about to send. `resume()` instead
        // drains and discards whatever's left with no listener attached to
        // buffer it -- bounded memory, same as rejecting, but the
        // connection stays alive long enough to actually deliver the `413`.
        req.resume();
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      settle(() => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw === '') {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    }

    function onError(error: Error): void {
      settle(() => reject(error));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Turn a route table into a `http.createServer` listener.
 *
 * Handlers get the raw `res`, so a streaming endpoint (`GET /events`, #29) can
 * hijack it for Server-Sent Events without fighting the router.
 */
export function createRequestListener(routes: readonly Route[], logger: Logger): RequestListener {
  const table = new Map<string, RouteHandler>();
  for (const route of routes) {
    table.set(routeKey(route.method, route.path), route.handle);
  }

  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://host.invalid');
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }

    const handle = table.get(routeKey(req.method ?? 'GET', url.pathname));
    if (handle === undefined) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    void (async () => {
      try {
        await handle({ req, res, url });
      } catch (cause) {
        logger.error(
          `Unhandled error in ${req.method} ${url.pathname}: ${
            cause instanceof Error ? cause.stack ?? cause.message : String(cause)
          }`,
        );
        if (res.headersSent) {
          res.end();
        } else {
          sendJson(res, 500, { error: 'internal_error' });
        }
      }
    })();
  };
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
