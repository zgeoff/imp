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

test('it always turns mouse, paste, focus and cursor keys off and shows the cursor', () => {
  const reset = readReset('plain output');

  for (const mode of ['1000', '1006', '2004', '1004', '1']) {
    expect(reset).toContain(`\u001B[?${mode}l`);
  }

  expect(reset).toContain('\u001B[?25h');
});

test('it leaves the alternate screen only when the output entered it', () => {
  expect(readReset('plain')).not.toContain('\u001B[?1049l');
  expect(readReset('\u001B[?1049hvim')).toContain('\u001B[?1049l');
  expect(readReset('\u001B[?1049hvim', 'bye\u001B[?1049l')).not.toContain('\u001B[?1049l');
  expect(readReset('\u001B[?47h\u001B[?47l\u001B[?1047h')).toContain('\u001B[?1049l');
});

test('it pops the kitty keyboard flags only after a push', () => {
  expect(readReset('\u001B[>4;1m')).not.toContain('\u001B[<99u');
  expect(readReset('\u001B[>1u')).toContain('\u001B[<99u');
  expect(readReset('\u001B[>u')).toContain('\u001B[<99u');
});
