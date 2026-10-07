import { expect, test } from 'bun:test';
import { createOutputCollector, formatCappedText } from './output-cap';

test('it returns the output whole within the cap', () => {
  const collector = createOutputCollector(10, 4);

  for (const chunk of ['abc', 'def']) {
    collector.push(new TextEncoder().encode(chunk));
  }

  const output = collector.finish();

  expect(output.droppedBytes).toBe(0);
  expect(formatCappedText(output)).toBe('abcdef');
});

test('it keeps the head and the tail and counts the middle past the cap', () => {
  const collector = createOutputCollector(8, 3);

  for (const chunk of ['0123', '4567', '89ab', 'cdef']) {
    collector.push(new TextEncoder().encode(chunk));
  }

  const output = collector.finish();

  expect(output.droppedBytes).toBe(8);
  expect(formatCappedText(output)).toBe('012\n[... 8 bytes dropped ...]\nbcdef');
});

test('it splits a single chunk larger than the cap between head and tail', () => {
  const collector = createOutputCollector(6, 2);

  collector.push(new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz'));

  const output = collector.finish();

  expect(formatCappedText(output)).toBe('ab\n[... 20 bytes dropped ...]\nwxyz');
});

test('it keeps only the start when the head is as large as the cap', () => {
  const collector = createOutputCollector(4, 4);

  for (const chunk of ['abcdef', 'ghij']) {
    collector.push(new TextEncoder().encode(chunk));
  }

  const output = collector.finish();

  expect(formatCappedText(output)).toBe('abcd\n[... 6 bytes dropped ...]\n');
});

test('it decodes invalid UTF-8 as the replacement character', () => {
  const collector = createOutputCollector(10, 10);

  collector.push(new Uint8Array([104, 255, 105]));

  const output = collector.finish();

  expect(formatCappedText(output)).toBe('h�i');
});

test('it decodes a character split between head and tail whole when nothing is dropped', () => {
  const collector = createOutputCollector(10, 3);

  collector.push(new TextEncoder().encode('abé'));

  const output = collector.finish();

  expect(formatCappedText(output)).toBe('abé');
});

test('it never splits a character at a cut and counts its bytes as dropped', () => {
  const collector = createOutputCollector(10, 5);

  for (const chunk of ['😀😀', 'xxxxxxxxxx', '😀😀']) {
    collector.push(new TextEncoder().encode(chunk));
  }

  const output = collector.finish();

  expect(output.droppedBytes).toBe(16);
  expect(formatCappedText(output)).toBe('😀\n[... 18 bytes dropped ...]\n😀');
});
