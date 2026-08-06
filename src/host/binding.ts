import { StartupError } from './errors.ts';

/**
 * Where the HTTP server listens.
 *
 * The spec deliberately declined to decide a bind address or port
 * ("left as whatever the simplest default turns out to be"), so: a fixed
 * high port, bound on all interfaces because story 26 requires a phone on the
 * same network to reach it. Both are overridable from the environment, which is
 * also how tests ask for an ephemeral port.
 */
export interface HttpBinding {
  readonly host: string;
  readonly port: number;
}

export const DEFAULT_HTTP_HOST = '0.0.0.0';
export const DEFAULT_HTTP_PORT = 7331;

export const HTTP_HOST_ENV_VAR = 'SCREEN_SOLVER_HOST';
export const HTTP_PORT_ENV_VAR = 'SCREEN_SOLVER_PORT';

export function readHttpBinding(env: NodeJS.ProcessEnv): HttpBinding {
  const host = env[HTTP_HOST_ENV_VAR]?.trim() || DEFAULT_HTTP_HOST;
  const rawPort = env[HTTP_PORT_ENV_VAR]?.trim();

  if (rawPort === undefined || rawPort === '') {
    return { host, port: DEFAULT_HTTP_PORT };
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new StartupError(
      'invalid-binding',
      `${HTTP_PORT_ENV_VAR} must be an integer between 0 and 65535, got "${rawPort}".`,
    );
  }

  return { host, port };
}

/** The address to hand a human, which `0.0.0.0` is not. */
export function clientUrl(binding: HttpBinding): string {
  const host =
    binding.host === '0.0.0.0' || binding.host === '::' || binding.host === ''
      ? 'localhost'
      : binding.host;
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `http://${bracketed}:${binding.port}`;
}
