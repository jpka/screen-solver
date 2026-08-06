const REDACTED = '[redacted]';
const inspectCustom = Symbol.for('nodejs.util.inspect.custom');

/**
 * A string that has to be asked for by name.
 *
 * The API key must never be written to disk, sent over IPC, or logged. The
 * cheapest structural guarantee for the "logged" half of that is a value whose
 * every accidental stringification — template literal, `console.log`,
 * `JSON.stringify`, `util.inspect` — produces `[redacted]`. Reading the real
 * value takes a deliberate `.reveal()` call, which greps cleanly.
 */
export interface Secret {
  reveal(): string;
  toString(): string;
  toJSON(): string;
}

export function createSecret(value: string): Secret {
  const secret: Secret = {
    reveal: () => value,
    toString: () => REDACTED,
    toJSON: () => REDACTED,
  };

  // Non-enumerable so spreading or shallow-cloning the holder doesn't drag a
  // live inspect hook around, and so `Object.keys` stays clean.
  Object.defineProperty(secret, inspectCustom, {
    value: () => REDACTED,
    enumerable: false,
  });

  return Object.freeze(secret);
}
