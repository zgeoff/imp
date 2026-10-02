import { expect, test } from 'bun:test';
import { createOutputCollector, formatCappedText } from './output-cap';

const encoder = new TextEncoder();

function collect(chunks: readonly string[], maxBytes: number, headBytes: number) {
  const collector = createOutputCollector(maxBytes, headBytes);

  for (const chunk of chunks) {
    collector.push(encoder.encode(chunk));
  }

  return collector.finish();
}

test('output within the cap comes back whole', () => {
  const output = collect(['abc', 'def'], 10, 4);

  expect(output.droppedBytes).toBe(0);
  expect(formatCappedText(output)).toBe('abcdef');
});

test('past the cap, the head and the tail stay and the middle is counted', () => {
  const output = collect(['0123', '4567', '89ab', 'cdef'], 8, 3);

  expect(output.droppedBytes).toBe(8);
  expect(formatCappedText(output)).toBe('012\n[... 8 bytes dropped ...]\nbcdef');
});

test('a single chunk larger than the cap is split between head and tail', () => {
  const output = collect(['abcdefghijklmnopqrstuvwxyz'], 6, 2);

  expect(formatCappedText(output)).toBe('ab\n[... 20 bytes dropped ...]\nwxyz');
});

test('a head as large as the cap keeps only the start', () => {
  const output = collect(['abcdef', 'ghij'], 4, 4);

  expect(formatCappedText(output)).toBe('abcd\n[... 6 bytes dropped ...]\n');
});

test('invalid UTF-8 becomes the replacement character', () => {
  const collector = createOutputCollector(10, 10);

  collector.push(new Uint8Array([104, 255, 105]));

  expect(formatCappedText(collector.finish())).toBe('h�i');
});

test('a character split between head and tail decodes whole when nothing is dropped', () => {
  const output = collect(['abé'], 10, 3);

  expect(formatCappedText(output)).toBe('abé');
});

test('a cut never splits a character; its bytes count as dropped', () => {
  const output = collect(['😀😀', 'x'.repeat(10), '😀😀'], 10, 5);

  expect(output.droppedBytes).toBe(16);
  expect(formatCappedText(output)).toBe('😀\n[... 18 bytes dropped ...]\n😀');
});
