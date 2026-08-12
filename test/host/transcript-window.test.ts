import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TranscriptChannel } from '../../src/host/audio/types.ts';
import { createTranscriptWindow } from '../../src/host/audio/window.ts';
import type { TranscriptEntry } from '../../src/host/logs/types.ts';

const T0 = Date.parse('2026-08-11T12:00:00.000Z');

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function entry(
  text: string,
  offsetMs: number,
  channel: TranscriptChannel = 'them',
): TranscriptEntry {
  return {
    recordingSessionId: 'session-1',
    channel,
    text,
    timestamp: at(offsetMs),
    startSeconds: offsetMs / 1000,
    endSeconds: offsetMs / 1000 + 1,
    model: 'nova-3',
  };
}

describe('createTranscriptWindow', () => {
  it('renders nothing at all when empty, rather than an empty block', () => {
    const window = createTranscriptWindow();
    assert.equal(window.render(T0), null);
  });

  it('renders oldest-first, one labelled line per entry', () => {
    const window = createTranscriptWindow();
    window.add(entry('first thing said', 0));
    window.add(entry('second thing said', 1_000));

    assert.equal(window.render(T0 + 2_000), 'Them: first thing said\nThem: second thing said');
  });

  it('labels the reserved microphone channel distinctly', () => {
    const window = createTranscriptWindow();
    window.add(entry('what they asked', 0, 'them'));
    window.add(entry('what I answered', 1_000, 'me'));

    assert.equal(window.render(T0 + 2_000), 'Them: what they asked\nMe: what I answered');
  });

  it('evicts entries older than the age bound', () => {
    const window = createTranscriptWindow({ maxAgeMs: 60_000 });
    window.add(entry('ancient history', 0));
    window.add(entry('still relevant', 55_000));

    assert.equal(window.render(T0 + 70_000), 'Them: still relevant');
  });

  it('returns null once every entry has aged out', () => {
    const window = createTranscriptWindow({ maxAgeMs: 1_000 });
    window.add(entry('gone', 0));
    assert.equal(window.render(T0 + 10_000), null);
  });

  it('trims the OLDEST entries when over the character cap, keeping the most recent', () => {
    // The recent end wins: the last sentence is the one most likely to be the
    // question actually being asked.
    const window = createTranscriptWindow({ maxChars: 30 });
    window.add(entry('aaaaaaaaaa', 0)); // "Them: aaaaaaaaaa" = 16 chars + newline
    window.add(entry('bbbbbbbbbb', 1_000));
    window.add(entry('cccccccccc', 2_000));

    const rendered = window.render(T0 + 3_000);
    assert.equal(rendered, 'Them: cccccccccc');
  });

  it('applies both bounds together', () => {
    const window = createTranscriptWindow({ maxAgeMs: 10_000, maxChars: 40 });
    window.add(entry('too old', 0));
    window.add(entry('kept one', 6_000));
    window.add(entry('kept two', 7_000));

    assert.equal(window.render(T0 + 9_000), 'Them: kept one\nThem: kept two');
  });

  it('clear() empties the window', () => {
    const window = createTranscriptWindow();
    window.add(entry('something', 0));
    window.clear();
    assert.equal(window.render(T0 + 1_000), null);
  });

  it('keeps an entry whose timestamp is unparseable rather than discarding real speech', () => {
    const window = createTranscriptWindow();
    window.add({ ...entry('malformed stamp', 0), timestamp: 'not a date' });
    assert.equal(window.render(), 'Them: malformed stamp');
  });
});
