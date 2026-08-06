import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  HTTP_HOST_ENV_VAR,
  HTTP_PORT_ENV_VAR,
  clientUrl,
  readHttpBinding,
} from '../../src/host/binding.ts';
import { StartupError } from '../../src/host/errors.ts';

describe('readHttpBinding', () => {
  it('falls back to the documented defaults', () => {
    assert.deepEqual(readHttpBinding({}), {
      host: DEFAULT_HTTP_HOST,
      port: DEFAULT_HTTP_PORT,
    });
  });

  it('honours environment overrides', () => {
    assert.deepEqual(
      readHttpBinding({ [HTTP_HOST_ENV_VAR]: '127.0.0.1', [HTTP_PORT_ENV_VAR]: '8080' }),
      { host: '127.0.0.1', port: 8080 },
    );
  });

  it('accepts port 0 so tests can ask for an ephemeral port', () => {
    assert.equal(readHttpBinding({ [HTTP_PORT_ENV_VAR]: '0' }).port, 0);
  });

  for (const bad of ['not-a-port', '-1', '70000', '80.5']) {
    it(`refuses to start on a nonsense port: ${bad}`, () => {
      assert.throws(
        () => readHttpBinding({ [HTTP_PORT_ENV_VAR]: bad }),
        (error: unknown) => {
          assert.ok(error instanceof StartupError);
          assert.equal(error.kind, 'invalid-binding');
          return true;
        },
      );
    });
  }
});

describe('clientUrl', () => {
  it('turns a wildcard bind into something a human can open', () => {
    assert.equal(clientUrl({ host: '0.0.0.0', port: 7331 }), 'http://localhost:7331');
  });

  it('keeps an explicit host', () => {
    assert.equal(clientUrl({ host: '192.168.1.20', port: 7331 }), 'http://192.168.1.20:7331');
  });
});
