import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkTargetStatus, checkWindowPresence } from '../../src/host/capture/target-status.ts';
import type { TargetWindowIdentity, WindowInfo } from '../../src/host/config/types.ts';

const KATA_TAB: TargetWindowIdentity = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };
const OTHER_WINDOW: WindowInfo = { processName: 'notepad.exe', title: 'Untitled - Notepad' };

describe('checkWindowPresence', () => {
  it('reports present when the target is in the current enumeration', async () => {
    const presence = await checkWindowPresence(KATA_TAB, async () => [OTHER_WINDOW, KATA_TAB]);
    assert.equal(presence, 'present');
  });

  it('reports vanished when the target is nowhere in the current enumeration', async () => {
    const presence = await checkWindowPresence(KATA_TAB, async () => [OTHER_WINDOW]);
    assert.equal(presence, 'vanished');
  });

  it('matches on both process name and title, not either alone', async () => {
    const sameTitleDifferentProcess: WindowInfo = { processName: 'firefox.exe', title: KATA_TAB.title };
    const presence = await checkWindowPresence(KATA_TAB, async () => [sameTitleDifferentProcess]);
    assert.equal(presence, 'vanished');
  });
});

describe('checkTargetStatus', () => {
  it('reports present + not minimized via the injected signals', async () => {
    const status = await checkTargetStatus(KATA_TAB, {
      enumerateWindows: async () => [KATA_TAB],
      isTargetMinimized: async () => false,
    });
    assert.deepEqual(status, { presence: 'present', minimized: false });
  });

  it('reports present + minimized via the injected signal, without a frame grab', async () => {
    const status = await checkTargetStatus(KATA_TAB, {
      enumerateWindows: async () => [KATA_TAB],
      isTargetMinimized: async () => true,
    });
    assert.deepEqual(status, { presence: 'present', minimized: true });
  });

  it('skips the minimized check entirely once the target has vanished', async () => {
    let minimizedCalls = 0;
    const status = await checkTargetStatus(KATA_TAB, {
      enumerateWindows: async () => [OTHER_WINDOW],
      isTargetMinimized: async () => {
        minimizedCalls += 1;
        return true;
      },
    });

    assert.deepEqual(status, { presence: 'vanished', minimized: false });
    assert.equal(minimizedCalls, 0, 'minimized-ness is not asked about a window that cannot be found');
  });
});
