import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import {
  API_KEY_ENV_VAR,
  DEEPGRAM_API_KEY_ENV_VAR,
  takeApiKey,
  takeDeepgramApiKey,
} from '../../src/host/api-key.ts';
import { StartupError } from '../../src/host/errors.ts';

const KEY = 'sk-ant-test-000111222';
const DEEPGRAM_KEY = 'dg-test-333444555';

describe('takeApiKey', () => {
  it('returns the key and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { [API_KEY_ENV_VAR]: KEY, PATH: '/usr/bin' };

    const secret = takeApiKey(env);

    assert.equal(secret.reveal(), KEY);
    assert.equal(API_KEY_ENV_VAR in env, false);
    assert.equal(env['PATH'], '/usr/bin', 'unrelated variables are left alone');
  });

  it('trims surrounding whitespace', () => {
    const env: NodeJS.ProcessEnv = { [API_KEY_ENV_VAR]: `  ${KEY}\n` };
    assert.equal(takeApiKey(env).reveal(), KEY);
  });

  it('refuses to start when the key is missing', () => {
    const env: NodeJS.ProcessEnv = {};

    assert.throws(
      () => takeApiKey(env),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.equal(error.kind, 'missing-api-key');
        assert.match(error.message, /ANTHROPIC_API_KEY is not set/);
        return true;
      },
    );
  });

  it('treats a blank key as missing, and still clears it', () => {
    const env: NodeJS.ProcessEnv = { [API_KEY_ENV_VAR]: '   ' };

    assert.throws(() => takeApiKey(env), StartupError);
    assert.equal(API_KEY_ENV_VAR in env, false);
  });

  it('does not leak the key through stringification, JSON, or inspect', () => {
    const secret = takeApiKey({ [API_KEY_ENV_VAR]: KEY });

    const renderings = [
      String(secret),
      `${secret}`,
      JSON.stringify({ apiKey: secret }),
      inspect(secret),
      inspect({ apiKey: secret }, { depth: 5 }),
    ];

    for (const rendering of renderings) {
      assert.equal(rendering.includes(KEY), false, `leaked the key: ${rendering}`);
      assert.match(rendering, /redacted/);
    }
  });
});

describe('takeDeepgramApiKey', () => {
  it('returns the key and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { [DEEPGRAM_API_KEY_ENV_VAR]: DEEPGRAM_KEY, PATH: '/usr/bin' };

    const secret = takeDeepgramApiKey(env);

    assert.equal(secret?.reveal(), DEEPGRAM_KEY);
    assert.equal(DEEPGRAM_API_KEY_ENV_VAR in env, false);
    assert.equal(env['PATH'], '/usr/bin', 'unrelated variables are left alone');
  });

  it('trims surrounding whitespace', () => {
    const env: NodeJS.ProcessEnv = { [DEEPGRAM_API_KEY_ENV_VAR]: `  ${DEEPGRAM_KEY}\n` };
    assert.equal(takeDeepgramApiKey(env)?.reveal(), DEEPGRAM_KEY);
  });

  it('returns null rather than throwing when missing -- recording is optional, unlike solving', () => {
    assert.equal(takeDeepgramApiKey({}), null);
  });

  it('treats a blank key as missing', () => {
    assert.equal(takeDeepgramApiKey({ [DEEPGRAM_API_KEY_ENV_VAR]: '   ' }), null);
  });

  it('clears the variable on EVERY path, including the missing one', () => {
    // The renderer snapshots `process.env` at creation, so a key left behind
    // on the failure path is just as leaked as one left behind on success.
    const blank: NodeJS.ProcessEnv = { [DEEPGRAM_API_KEY_ENV_VAR]: '' };
    takeDeepgramApiKey(blank);
    assert.equal(DEEPGRAM_API_KEY_ENV_VAR in blank, false);

    const whitespace: NodeJS.ProcessEnv = { [DEEPGRAM_API_KEY_ENV_VAR]: '  ' };
    takeDeepgramApiKey(whitespace);
    assert.equal(DEEPGRAM_API_KEY_ENV_VAR in whitespace, false);
  });

  it('does not leak the key through stringification, JSON, or inspect', () => {
    const secret = takeDeepgramApiKey({ [DEEPGRAM_API_KEY_ENV_VAR]: DEEPGRAM_KEY });
    assert.ok(secret !== null);

    for (const rendering of [
      String(secret),
      JSON.stringify({ apiKey: secret }),
      inspect({ apiKey: secret }, { depth: 5 }),
    ]) {
      assert.equal(rendering.includes(DEEPGRAM_KEY), false, `leaked the key: ${rendering}`);
      assert.match(rendering, /redacted/);
    }
  });
});
