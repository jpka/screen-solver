/**
 * The ways the host is allowed to refuse to start.
 *
 * Every one of these is fatal by design: the app either comes up in a fully
 * usable state or it prints one clear line and exits. There is no degraded
 * mode — see the spec's "Process lifecycle" decision.
 */
export type StartupFailureKind =
  | 'missing-api-key'
  | 'invalid-binding'
  | 'state-root-unwritable'
  | 'port-unavailable'
  | 'config-invalid';

/**
 * A refusal to start, carrying a machine-readable `kind` alongside a message
 * written for whoever is looking at the terminal.
 */
export class StartupError extends Error {
  readonly kind: StartupFailureKind;

  constructor(kind: StartupFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StartupError';
    this.kind = kind;
  }
}

export function isStartupError(value: unknown): value is StartupError {
  return value instanceof StartupError;
}
