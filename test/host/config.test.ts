import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CONFIG_FILE_NAME,
  loadConfigStore,
  resolveTargetWindowOnStartup,
} from '../../src/host/config/store.ts';
import { StartupError } from '../../src/host/errors.ts';
import {
  DEFAULT_RECORDING_SETTINGS,
  type ConfigChangeEvent,
  type WindowInfo,
} from '../../src/host/config/types.ts';
import { tempStateRoot } from '../helpers/temp-state-root.ts';

const KATA_TAB = { processName: 'chrome.exe', title: 'Two Sum - LeetCode' };
const OTHER_WINDOW: WindowInfo = { processName: 'notepad.exe', title: 'Untitled - Notepad' };

describe('loadConfigStore', () => {
  it('creates config.json on first run, with a null target and null provider', async (t) => {
    const stateRoot = await tempStateRoot(t);

    const store = await loadConfigStore({ stateRoot });

    // #45 added the `recording` block to the config shape, so "a fresh
    // config.json" is now three fields rather than two. Asserted in full
    // rather than field-by-field, deliberately: this test's job is to pin the
    // whole on-disk shape, and a later ticket adding a fourth field should
    // have to come here and say so.
    assert.deepEqual(store.get(), {
      targetWindow: null,
      provider: null,
      recording: DEFAULT_RECORDING_SETTINGS,
    });

    const onDisk = JSON.parse(await readFile(join(stateRoot, CONFIG_FILE_NAME), 'utf8'));
    assert.deepEqual(onDisk, {
      targetWindow: null,
      provider: null,
      recording: DEFAULT_RECORDING_SETTINGS,
    });
  });

  it('is a no-op on a config.json that already exists', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const configPath = join(stateRoot, CONFIG_FILE_NAME);
    const saved = { targetWindow: KATA_TAB, provider: null };
    await writeFile(configPath, JSON.stringify(saved));

    const store = await loadConfigStore({ stateRoot, enumerateWindows: async () => [KATA_TAB] });

    // The saved file predates #45 and has no `recording` block -- exactly what
    // every config.json written by an earlier version looks like. It loads with
    // defaults filled in rather than refusing to start, and the file itself is
    // still not rewritten (this test's "no-op" claim).
    assert.deepEqual(store.get(), { ...saved, recording: DEFAULT_RECORDING_SETTINGS });
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), saved);
  });

  it('refuses to load a config.json that is not valid JSON', async (t) => {
    const stateRoot = await tempStateRoot(t);
    await writeFile(join(stateRoot, CONFIG_FILE_NAME), 'not json');

    await assert.rejects(
      () => loadConfigStore({ stateRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.equal(error.kind, 'config-invalid');
        return true;
      },
    );
  });

  it('enumerates the windows an injected enumerator lists', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const windows: WindowInfo[] = [KATA_TAB, OTHER_WINDOW];

    const store = await loadConfigStore({ stateRoot, enumerateWindows: async () => windows });

    assert.deepEqual(await store.listWindows(), windows);
  });

  it('persists a target window change, and it survives a simulated restart', async (t) => {
    const stateRoot = await tempStateRoot(t);

    const first = await loadConfigStore({ stateRoot });
    await first.setTargetWindow(KATA_TAB);

    // "Restart": load a brand new store from the same directory, from scratch.
    const second = await loadConfigStore({ stateRoot, enumerateWindows: async () => [KATA_TAB] });

    assert.deepEqual(second.get().targetWindow, KATA_TAB);
    assert.deepEqual(
      JSON.parse(await readFile(join(stateRoot, CONFIG_FILE_NAME), 'utf8')).targetWindow,
      KATA_TAB,
    );
  });

  it('applies a target window change live, with no re-read from disk', async (t) => {
    const stateRoot = await tempStateRoot(t);
    let reads = 0;
    const store = await loadConfigStore({
      stateRoot,
      readFile: async (path) => {
        reads += 1;
        return readFile(path, 'utf8');
      },
      writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
    });
    const readsAfterLoad = reads;

    await store.setTargetWindow(KATA_TAB);

    assert.deepEqual(store.get().targetWindow, KATA_TAB, 'the in-memory config updates immediately');
    assert.equal(reads, readsAfterLoad, 'setTargetWindow never re-reads the file to pick up its own write');
  });

  it('clearing the target window persists null', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const store = await loadConfigStore({ stateRoot });
    await store.setTargetWindow(KATA_TAB);

    await store.setTargetWindow(null);

    assert.equal(store.get().targetWindow, null);
    const onDisk = JSON.parse(await readFile(join(stateRoot, CONFIG_FILE_NAME), 'utf8'));
    assert.equal(onDisk.targetWindow, null);
  });

  it('emits a change signal, observed by a subscriber, when the target window is set', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const store = await loadConfigStore({ stateRoot });
    const seen: ConfigChangeEvent[] = [];
    const unsubscribe = store.onChange((event) => seen.push(event));

    await store.setTargetWindow(KATA_TAB);

    assert.deepEqual(seen, [{ type: 'config', target: KATA_TAB }]);

    unsubscribe();
    await store.setTargetWindow(null);
    assert.deepEqual(seen, [{ type: 'config', target: KATA_TAB }], 'unsubscribed listeners hear nothing more');
  });

  it('re-resolves a saved target window on startup when it is still open', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const first = await loadConfigStore({ stateRoot });
    await first.setTargetWindow(KATA_TAB);

    const restarted = await loadConfigStore({
      stateRoot,
      enumerateWindows: async () => [OTHER_WINDOW, KATA_TAB],
    });

    assert.deepEqual(restarted.get().targetWindow, KATA_TAB);
  });

  it('falls back to "no target configured" on startup when the saved window is gone', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const first = await loadConfigStore({ stateRoot });
    await first.setTargetWindow(KATA_TAB);

    const restarted = await loadConfigStore({
      stateRoot,
      enumerateWindows: async () => [OTHER_WINDOW],
    });

    assert.equal(restarted.get().targetWindow, null, 'documented fallback: resolution failure means no target');
  });

  it('does not touch config.json when resolution falls back to null', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const configPath = join(stateRoot, CONFIG_FILE_NAME);
    const first = await loadConfigStore({ stateRoot });
    await first.setTargetWindow(KATA_TAB);

    await loadConfigStore({ stateRoot, enumerateWindows: async () => [] });

    // The saved identity survives on disk even though the live target fell
    // back to null, so the same window reappearing later resolves again.
    const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(onDisk.targetWindow, KATA_TAB);
  });

  it('starts up with no live target, rather than refusing to start, when enumerateWindows rejects', async (t) => {
    const stateRoot = await tempStateRoot(t);
    const configPath = join(stateRoot, CONFIG_FILE_NAME);
    const first = await loadConfigStore({ stateRoot });
    await first.setTargetWindow(KATA_TAB);

    const restarted = await loadConfigStore({
      stateRoot,
      enumerateWindows: async () => {
        throw new Error('Get-Process failed: execution policy restricted');
      },
    });

    assert.equal(
      restarted.get().targetWindow,
      null,
      'an enumeration failure degrades to "no target configured" instead of failing bootstrap',
    );
    const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(onDisk.targetWindow, KATA_TAB, 'the persisted identity is untouched by the failure');
  });
});

describe('resolveTargetWindowOnStartup', () => {
  it('resolves to null immediately when nothing was saved', async () => {
    const result = await resolveTargetWindowOnStartup(null, async () => {
      throw new Error('should not enumerate when there is nothing to resolve');
    });
    assert.equal(result, null);
  });

  it('keeps the saved target when it is still in the current enumeration', async () => {
    const result = await resolveTargetWindowOnStartup(KATA_TAB, async () => [OTHER_WINDOW, KATA_TAB]);
    assert.deepEqual(result, KATA_TAB);
  });

  it('falls back to null when the saved target is not in the current enumeration', async () => {
    const result = await resolveTargetWindowOnStartup(KATA_TAB, async () => [OTHER_WINDOW]);
    assert.equal(result, null);
  });

  it('matches on both process name and title, not either alone', async () => {
    const sameTitleDifferentProcess: WindowInfo = { processName: 'firefox.exe', title: KATA_TAB.title };
    const result = await resolveTargetWindowOnStartup(KATA_TAB, async () => [sameTitleDifferentProcess]);
    assert.equal(result, null);
  });

  it('falls back to null, rather than throwing, when enumerateWindows itself rejects', async () => {
    const result = await resolveTargetWindowOnStartup(KATA_TAB, async () => {
      throw new Error('Get-Process failed: execution policy restricted');
    });
    assert.equal(result, null);
  });
});
