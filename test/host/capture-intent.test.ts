import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTargetIntentTracker } from '../../src/host/capture/intent.ts';

describe('createTargetIntentTracker', () => {
  it('starts active', () => {
    const tracker = createTargetIntentTracker();
    assert.equal(tracker.current(), 'active');
  });

  it('pause() flips it to paused', () => {
    const tracker = createTargetIntentTracker();
    tracker.pause();
    assert.equal(tracker.current(), 'paused');
  });

  it('resume() flips a paused tracker back to active', () => {
    const tracker = createTargetIntentTracker();
    tracker.pause();
    tracker.resume();
    assert.equal(tracker.current(), 'active');
  });

  it('resume() on an already-active tracker is a harmless no-op', () => {
    const tracker = createTargetIntentTracker();
    tracker.resume();
    assert.equal(tracker.current(), 'active');
  });
});
