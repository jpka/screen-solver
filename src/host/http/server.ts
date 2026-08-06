import { createServer, type Server } from 'node:http';
import { clientUrl, type HttpBinding } from '../binding.ts';
import { StartupError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import { createRequestListener, type Route } from './router.ts';

export interface ListeningHttpServer {
  /** The host actually bound. */
  readonly host: string;
  /** The port actually bound — resolved, so port 0 reports the real number. */
  readonly port: number;
  /** A URL a human can paste into a browser. */
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

export interface StartHttpServerOptions {
  readonly binding: HttpBinding;
  readonly routes: readonly Route[];
  readonly logger: Logger;
}

export type StartHttpServer = (options: StartHttpServerOptions) => Promise<ListeningHttpServer>;

/**
 * Bind the HTTP port.
 *
 * A bind failure is a refusal to start, exactly like a missing API key — the
 * user finds out immediately rather than by a client silently failing to
 * connect (story 35).
 *
 * @throws {StartupError} `port-unavailable`
 */
export const startHttpServer: StartHttpServer = ({ binding, routes, logger }) => {
  return new Promise<ListeningHttpServer>((resolve, reject) => {
    const server = createServer(createRequestListener(routes, logger));

    const onListenFailed = (cause: NodeJS.ErrnoException) => {
      server.close();
      reject(
        new StartupError('port-unavailable', bindFailureMessage(binding, cause), { cause }),
      );
    };

    server.once('error', onListenFailed);

    server.listen(binding.port, binding.host, () => {
      server.removeListener('error', onListenFailed);

      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : binding.port;
      const resolved = { host: binding.host, port };

      resolve({
        host: resolved.host,
        port: resolved.port,
        url: clientUrl(resolved),
        server,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
};

function bindFailureMessage(binding: HttpBinding, cause: NodeJS.ErrnoException): string {
  const where = `${binding.host}:${binding.port}`;
  switch (cause.code) {
    case 'EADDRINUSE':
      return [
        `Port ${binding.port} is already in use, so Screen Solver can't serve its web client.`,
        `Stop whatever is listening on ${where}, or set SCREEN_SOLVER_PORT to a free port.`,
      ].join('\n');
    case 'EACCES':
      return `Not allowed to bind ${where}. Pick a port above 1024 with SCREEN_SOLVER_PORT.`;
    case 'EADDRNOTAVAIL':
      return `No interface matches ${binding.host}. Check SCREEN_SOLVER_HOST.`;
    default:
      return `Could not bind ${where}: ${cause.message}`;
  }
}
