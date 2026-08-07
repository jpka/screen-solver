import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStatusTracker } from '../../src/host/solve/status.ts';
import type { SolveOutcome } from '../../src/host/solve/types.ts';

const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

const DONE: SolveOutcome = { type: 'done', text: '# Two Sum\n...', usage: USAGE, stopReason: 'end_turn' };
const INTERRUPTED: SolveOutcome = { type: 'interrupted', text: 'partial' };
const AUTH_ERROR: SolveOutcome = { type: 'error', kind: 'auth', message: 'key revoked', text: '' };
const TRANSIENT_ERROR: SolveOutcome = { type: 'error', kind: 'transient', message: 'gave up retrying', text: '' };
const REFUSAL_ERROR: SolveOutcome = { type: 'error', kind: 'refusal', message: 'refused', text: '' };

describe('createStatusTracker', () => {
  it('starts silent', () => {
    const tracker = createStatusTracker();
    assert.deepEqual(tracker.current(), { level: 'silent', kind: null });
  });

  it('an auth error flips the tracker sticky and reports the transition', () => {
    const tracker = createStatusTracker();
    const transition = tracker.onOutcome(AUTH_ERROR);
    assert.deepEqual(transition, { level: 'sticky', kind: 'auth' });
    assert.deepEqual(tracker.current(), { level: 'sticky', kind: 'auth' });
  });

  it('a transient error escalates to auto-recovering, not sticky', () => {
    const tracker = createStatusTracker();
    const transition = tracker.onOutcome(TRANSIENT_ERROR);
    assert.deepEqual(transition, { level: 'auto-recovering', kind: 'transient' });
    assert.notEqual(tracker.current().level, 'sticky');
  });

  it('a refusal error escalates to auto-recovering, same as transient', () => {
    const tracker = createStatusTracker();
    const transition = tracker.onOutcome(REFUSAL_ERROR);
    assert.deepEqual(transition, { level: 'auto-recovering', kind: 'refusal' });
  });

  it('a done outcome resolves an auto-recovering status back to silent', () => {
    const tracker = createStatusTracker();
    tracker.onOutcome(TRANSIENT_ERROR);
    const transition = tracker.onOutcome(DONE);
    assert.deepEqual(transition, { level: 'silent', kind: null });
  });

  it('a done outcome resolves a sticky status back to silent -- "explicitly resolved"', () => {
    const tracker = createStatusTracker();
    tracker.onOutcome(AUTH_ERROR);
    const transition = tracker.onOutcome(DONE);
    assert.deepEqual(transition, { level: 'silent', kind: null });
    assert.deepEqual(tracker.current(), { level: 'silent', kind: null });
  });

  it('sticky survives an unrelated transient error in between -- it does not downgrade to auto-recovering', () => {
    const tracker = createStatusTracker();
    tracker.onOutcome(AUTH_ERROR);
    const transition = tracker.onOutcome(TRANSIENT_ERROR);
    assert.equal(transition, null, 'no change to report -- sticky is unaffected');
    assert.deepEqual(tracker.current(), { level: 'sticky', kind: 'auth' });
  });

  it('sticky survives further unrelated auth errors -- stays sticky across subsequent unrelated solves', () => {
    const tracker = createStatusTracker();
    tracker.onOutcome(AUTH_ERROR);
    const transition = tracker.onOutcome(AUTH_ERROR);
    assert.equal(transition, null, 'no change to report -- already sticky for the same reason');
    assert.deepEqual(tracker.current(), { level: 'sticky', kind: 'auth' });
  });

  it('a repeated transient error while already auto-recovering reports no further change', () => {
    const tracker = createStatusTracker();
    tracker.onOutcome(TRANSIENT_ERROR);
    const transition = tracker.onOutcome(TRANSIENT_ERROR);
    assert.equal(transition, null);
    assert.deepEqual(tracker.current(), { level: 'auto-recovering', kind: 'transient' });
  });

  it('a done outcome while already silent reports no change', () => {
    const tracker = createStatusTracker();
    const transition = tracker.onOutcome(DONE);
    assert.equal(transition, null);
  });

  it('an interrupted outcome never changes the status, from any level', () => {
    for (const seed of [null, TRANSIENT_ERROR, AUTH_ERROR]) {
      const tracker = createStatusTracker();
      if (seed) tracker.onOutcome(seed);
      const before = tracker.current();
      const transition = tracker.onOutcome(INTERRUPTED);
      assert.equal(transition, null);
      assert.deepEqual(tracker.current(), before);
    }
  });
});
