import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startCaptureSessionCoordinator } from '../../src/host/capture/session-coordinator.ts';
import type { ConfigChangeEvent, TargetWindowIdentity } from '../../src/host/config/types.ts';
import type { CapturedFrame, CaptureSession, OpenCaptureSession } from '../../src/host/capture/types.ts';

const KATA_TAB: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };
const OTHER_TAB: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Valid Parentheses - LeetCode' };

const FRAME: CapturedFrame = {
  mediaType: 'image/jpeg',
  bytes: new Uint8Array([1, 2, 3]),
  width: 1200,
  height: 800,
  quality: 'ok',
};

/** Records every open/close, handing back a fake session per open. */
function fakeSessions() {
  const opens: TargetWindowIdentity[] = [];
  const closes: TargetWindowIdentity[] = [];

  const openSession: OpenCaptureSession = async (target) => {
    opens.push(target);
    const session: CaptureSession = {
      captureFrame: async () => FRAME,
      close: async () => {
        closes.push(target);
      },
    };
    return session;
  };

  return { openSession, opens, closes };
}

/** A minimal stand-in for `ConfigStore`'s change bus -- just `onChange` + a way to fire it. */
function changeBus() {
  const listeners = new Set<(event: ConfigChangeEvent) => void>();
  return {
    onChange: (listener: (event: ConfigChangeEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (target: TargetWindowIdentity | null) => {
      const event: ConfigChangeEvent = { type: 'config', target };
      for (const listener of listeners) listener(event);
    },
  };
}

describe('startCaptureSessionCoordinator', () => {
  it('opens exactly one session when a target is already configured at startup', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();

    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: KATA_TAB,
      onChange: bus.onChange,
    });
    await coordinator.settled();

    assert.deepEqual(fakes.opens, [KATA_TAB]);
    assert.deepEqual(fakes.closes, []);
    assert.deepEqual(coordinator.currentTarget(), KATA_TAB);
  });

  it('opens no session at startup when nothing is configured yet', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();

    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: null,
      onChange: bus.onChange,
    });
    await coordinator.settled();

    assert.deepEqual(fakes.opens, []);
    assert.equal(coordinator.currentTarget(), null);
  });

  it('opens exactly one session the moment a target is selected', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();
    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: null,
      onChange: bus.onChange,
    });
    await coordinator.settled();

    bus.emit(KATA_TAB);
    await coordinator.settled();

    assert.deepEqual(fakes.opens, [KATA_TAB]);
    assert.deepEqual(coordinator.currentTarget(), KATA_TAB);
  });

  it('tears down the old session and opens exactly one new one when the target changes', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();
    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: KATA_TAB,
      onChange: bus.onChange,
    });
    await coordinator.settled();

    bus.emit(OTHER_TAB);
    await coordinator.settled();

    assert.deepEqual(fakes.opens, [KATA_TAB, OTHER_TAB]);
    assert.deepEqual(fakes.closes, [KATA_TAB]);
    assert.deepEqual(coordinator.currentTarget(), OTHER_TAB);
  });

  it('closes the open session and opens nothing new when the target is cleared', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();
    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: KATA_TAB,
      onChange: bus.onChange,
    });
    await coordinator.settled();

    bus.emit(null);
    await coordinator.settled();

    assert.deepEqual(fakes.opens, [KATA_TAB]);
    assert.deepEqual(fakes.closes, [KATA_TAB]);
    assert.equal(coordinator.currentTarget(), null);
  });

  it('stays open across repeated frame requests while idle -- never re-opened per capture', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();
    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: KATA_TAB,
      onChange: bus.onChange,
    });
    await coordinator.settled();

    const frames = await Promise.all([
      coordinator.captureFrame(),
      coordinator.captureFrame(),
      coordinator.captureFrame(),
    ]);

    assert.deepEqual(frames, [FRAME, FRAME, FRAME]);
    assert.deepEqual(fakes.opens, [KATA_TAB], 'requesting frames never opens a fresh session');
    assert.deepEqual(fakes.closes, []);
  });

  it('captureFrame returns null when no session is open', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();
    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: null,
      onChange: bus.onChange,
    });
    await coordinator.settled();

    assert.equal(await coordinator.captureFrame(), null);
  });

  it('skips a superseded open entirely when the change arrives before it has even started', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();

    // No `await` between construction and the second change: the initial
    // open for KATA_TAB has been scheduled but its openSession() call has not
    // actually run yet when OTHER_TAB supersedes it.
    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: KATA_TAB,
      onChange: bus.onChange,
    });
    bus.emit(OTHER_TAB);
    await coordinator.settled();

    assert.deepEqual(fakes.opens, [OTHER_TAB], 'the superseded KATA_TAB open never even ran');
    assert.deepEqual(fakes.closes, []);
    assert.deepEqual(coordinator.currentTarget(), OTHER_TAB);
  });

  it('closes a session whose open resolves after it has already been superseded', async () => {
    const opens: TargetWindowIdentity[] = [];
    const closes: TargetWindowIdentity[] = [];
    let releaseFirstOpen: () => void = () => {};
    const firstOpenGate = new Promise<void>((resolve) => {
      releaseFirstOpen = resolve;
    });
    let firstOpenStarted: () => void = () => {};
    const firstOpenStartedSignal = new Promise<void>((resolve) => {
      firstOpenStarted = resolve;
    });

    const openSession: OpenCaptureSession = async (target) => {
      opens.push(target);
      if (target === KATA_TAB) {
        firstOpenStarted();
        await firstOpenGate;
      }
      return {
        captureFrame: async () => FRAME,
        close: async () => {
          closes.push(target);
        },
      };
    };

    const bus = changeBus();
    const coordinator = startCaptureSessionCoordinator({
      openSession,
      initialTarget: KATA_TAB,
      onChange: bus.onChange,
    });

    // Let the KATA_TAB open actually start before superseding it, so this
    // exercises the post-open supersession path rather than the pre-open
    // skip covered above.
    await firstOpenStartedSignal;
    bus.emit(OTHER_TAB);
    releaseFirstOpen();
    await coordinator.settled();

    assert.deepEqual(opens, [KATA_TAB, OTHER_TAB]);
    assert.deepEqual(closes, [KATA_TAB], 'the superseded session is closed once its open resolves, never left running');
    assert.deepEqual(coordinator.currentTarget(), OTHER_TAB);
  });

  it('stop() closes whatever is open and unsubscribes -- further config changes are ignored', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();
    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: KATA_TAB,
      onChange: bus.onChange,
    });
    await coordinator.settled();

    await coordinator.stop();
    assert.deepEqual(fakes.closes, [KATA_TAB]);

    bus.emit(OTHER_TAB);
    assert.deepEqual(fakes.opens, [KATA_TAB], 'no further opens after stop, even if the bus still fires');
  });

  it('stop() is a clean no-op when nothing was ever open', async () => {
    const fakes = fakeSessions();
    const bus = changeBus();
    const coordinator = startCaptureSessionCoordinator({
      openSession: fakes.openSession,
      initialTarget: null,
      onChange: bus.onChange,
    });
    await coordinator.settled();

    await coordinator.stop();

    assert.deepEqual(fakes.opens, []);
    assert.deepEqual(fakes.closes, []);
  });
});
