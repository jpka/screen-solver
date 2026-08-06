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
