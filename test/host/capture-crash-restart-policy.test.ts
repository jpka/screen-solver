import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCrashRestartPolicy } from '../../src/host/capture/crash-restart-policy.ts';

const T0 = new Date('2026-08-07T00:00:00.000Z');
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

describe('createCrashRestartPolicy', () => {
  it('restarts immediately (no delay) on the first crash of a loop', () => {
    const policy = createCrashRestartPolicy();
    assert.deepEqual(policy.onCrash(T0), { action: 'restart', delayMs: 0, attempt: 1 });
  });

  it('backs off further on each subsequent crash within the loop window', () => {
    const policy = createCrashRestartPolicy();
    assert.deepEqual(policy.onCrash(at(0)), { action: 'restart', delayMs: 0, attempt: 1 });
    assert.deepEqual(policy.onCrash(at(100)), { action: 'restart', delayMs: 1_000, attempt: 2 });
    assert.deepEqual(policy.onCrash(at(200)), { action: 'restart', delayMs: 5_000, attempt: 3 });
  });

  it('gives up once more crashes happen than maxRestarts allows', () => {
    const policy = createCrashRestartPolicy({ maxRestarts: 2 });
    assert.equal(policy.onCrash(at(0)).action, 'restart');
    assert.equal(policy.onCrash(at(10)).action, 'restart');
    assert.deepEqual(policy.onCrash(at(20)), { action: 'give-up', attempt: 3 });
  });

  it('holds at the last configured backoff for any further restart short of the give-up threshold', () => {
    const policy = createCrashRestartPolicy({ maxRestarts: 5, backoffMs: [0, 1_000] });
    assert.equal(policy.onCrash(at(0)).action, 'restart');
    assert.equal(policy.onCrash(at(10)).action, 'restart');
    const third = policy.onCrash(at(20));
    assert.deepEqual(third, { action: 'restart', delayMs: 1_000, attempt: 3 });
  });

  it('a crash far outside the loop window starts a fresh loop instead of continuing the old one', () => {
    const policy = createCrashRestartPolicy({ maxRestarts: 2, loopWindowMs: 60_000 });
    assert.equal(policy.onCrash(at(0)).action, 'restart');
    assert.equal(policy.onCrash(at(10)).action, 'restart');
    assert.deepEqual(policy.onCrash(at(20)), { action: 'give-up', attempt: 3 });

    // Long after the loop window has elapsed: a fresh, unrelated crash.
    const fresh = policy.onCrash(at(120_000));
    assert.deepEqual(fresh, { action: 'restart', delayMs: 0, attempt: 1 });
  });

  it('reset() clears the loop counter immediately, independent of timing', () => {
    const policy = createCrashRestartPolicy();
    policy.onCrash(at(0));
    policy.onCrash(at(10));
    policy.reset();

    const next = policy.onCrash(at(20));
    assert.deepEqual(next, { action: 'restart', delayMs: 0, attempt: 1 });
  });
});
