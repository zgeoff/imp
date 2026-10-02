import { expect, test } from 'bun:test';
import { createModeWatcher } from './terminal-modes';

const encoder = new TextEncoder();

function readReset(...chunks: readonly string[]): string {
  const watcher = createModeWatcher();

  for (const chunk of chunks) {
    watcher.observe(encoder.encode(chunk));
  }

  return watcher.buildReset();
}

test('it always turns mouse, focus and modifyOtherKeys off and shows the cursor', () => {
  const reset = readReset('plain output');

  for (const mode of ['1000', '1006', '1004']) {
    expect(reset).toContain(`\u001B[?${mode}l`);
  }

  expect(reset).toContain('\u001B[?25h');
  expect(reset).toContain('\u001B[>4;0m');
});

test('it turns paste and cursor keys off only when the session turned them on', () => {
  expect(readReset('plain')).not.toContain('\u001B[?2004l');
  expect(readReset('plain')).not.toContain('\u001B[?1l');
  expect(readReset('\u001B[?2004h\u001B[?1h')).toContain('\u001B[?2004l\u001B[?1l');
  expect(readReset('\u001B[?2004h', '\u001B[?2004l')).not.toContain('\u001B[?2004l');
});

test('it leaves the alternate screen only when the output entered it', () => {
  expect(readReset('plain')).not.toContain('\u001B[?1049l');
  expect(readReset('\u001B[?1049hvim')).toContain('\u001B[?1049l');
  expect(readReset('\u001B[?1049hvim', 'bye\u001B[?1049l')).not.toContain('\u001B[?1049l');
  expect(readReset('\u001B[?47h\u001B[?47l\u001B[?1047h')).toContain('\u001B[?1049l');
});

test('it pops as many kitty keyboard entries as the session pushed, per screen', () => {
  expect(readReset('\u001B[>4;1m')).not.toContain('\u001B[<');
  expect(readReset('\u001B[>1u\u001B[>u')).toContain('\u001B[<2u');
  expect(readReset('\u001B[>1u\u001B[>3u\u001B[<u')).toContain('\u001B[<1u');
  expect(readReset('\u001B[>1u\u001B[<5u')).not.toContain('\u001B[<');

  expect(readReset('\u001B[>1u\u001B[?1049h\u001B[>3u\u001B[>3u')).toStartWith(
    '\u001B[<2u\u001B[?1049l\u001B[<1u',
  );
});

test('it reads a sequence split across chunks, and RIS resets what it saw', () => {
  expect(readReset('\u001B[?20', '04h')).toContain('\u001B[?2004l');
  expect(readReset('\u001B[?2004h\u001B[>1u', '\u001Bc')).toBe(readReset('plain'));
});
