/**
 * The host's console surface.
 *
 * Kept behind an interface so tests can capture output, and so the "sticky
 * status prints one line to the host's console" rule (ticket #32) has a single
 * place to land later.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info(message) {
    console.log(message);
  },
  warn(message) {
    console.warn(message);
  },
  error(message) {
    console.error(message);
  },
};

/** A logger that swallows everything — useful in tests. */
export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
