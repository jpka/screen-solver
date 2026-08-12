import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_RECONNECT_DELAYS_MS,
  createReconnectPolicy,
} from '../../src/host/audio/reconnect-policy.ts';

/** Shorthand for "this socket died immediately", the common case in these tests. */
const INSTANTLY = 0;

describe('createReconnectPolicy', () => {
  it('climbs the ladder on consecutive failures', () => {
    const policy = createReconnectPolicy();
    assert.deepEqual(policy.onDisconnect(INSTANTLY), { delayMs: 250, attempt: 1 });
    assert.deepEqual(policy.onDisconnect(INSTANTLY), { delayMs: 1_000, attempt: 2 });
    assert.deepEqual(policy.onDisconnect(INSTANTLY), { delayMs: 3_000, attempt: 3 });
    assert.deepEqual(policy.onDisconnect(INSTANTLY), { delayMs: 10_000, attempt: 4 });
    assert.deepEqual(policy.onDisconnect(INSTANTLY), { delayMs: 30_000, attempt: 5 });
  });

  it('holds at the last rung forever instead of giving up', () => {
    const policy = createReconnectPolicy();
    for (let i = 0; i < DEFAULT_RECONNECT_DELAYS_MS.length; i += 1) policy.onDisconnect(INSTANTLY);

    // The whole point of the divergence from the provider's retry policy: a
    // recording that has been offline for an hour is still trying.
    for (let i = 0; i < 100; i += 1) {
      assert.equal(policy.onDisconnect(INSTANTLY).delayMs, 30_000);
    }
    assert.equal(policy.onDisconnect(INSTANTLY).attempt, DEFAULT_RECONNECT_DELAYS_MS.length + 101);
  });

  it('a connection that stayed open long enough resets the ladder to the bottom', () => {
    const policy = createReconnectPolicy({ healthyConnectionMs: 60_000 });
    policy.onDisconnect(INSTANTLY);
    policy.onDisconnect(INSTANTLY);
    assert.deepEqual(policy.onDisconnect(INSTANTLY), { delayMs: 3_000, attempt: 3 });

    // Two minutes of working connection: the next failure is a new problem.
    assert.deepEqual(policy.onDisconnect(120_000), { delayMs: 250, attempt: 1 });
  });

  it('a flapping connection cannot reset the ladder by reconnecting briefly', () => {
    const policy = createReconnectPolicy({ healthyConnectionMs: 60_000 });
    // Opens, works for two seconds, dies. Repeatedly. Without the healthy
    // threshold this would sit at rung one forever and hammer the API.
    assert.equal(policy.onDisconnect(2_000).delayMs, 250);
    assert.equal(policy.onDisconnect(2_000).delayMs, 1_000);
    assert.equal(policy.onDisconnect(2_000).delayMs, 3_000);
  });

  it('reset() clears the streak', () => {
    const policy = createReconnectPolicy();
    policy.onDisconnect(INSTANTLY);
    policy.onDisconnect(INSTANTLY);
    policy.reset();
    assert.deepEqual(policy.onDisconnect(INSTANTLY), { delayMs: 250, attempt: 1 });
  });

  it('honours an injected ladder', () => {
    const policy = createReconnectPolicy({ delaysMs: [5, 50] });
    assert.equal(policy.onDisconnect(INSTANTLY).delayMs, 5);
    assert.equal(policy.onDisconnect(INSTANTLY).delayMs, 50);
    assert.equal(policy.onDisconnect(INSTANTLY).delayMs, 50);
  });
});
