import { expect, test } from 'bun:test';
import { splitLines } from './split-lines';

test('it splits lines that span and share chunks', async () => {
  const lines = ReadableStream.from(['one\ntw', 'o\nthree\n', 'four']).pipeThrough(splitLines());

  const read = await Array.fromAsync(lines);

  expect(read).toStrictEqual(['one', 'two', 'three', 'four']);
});

test('it keeps an empty line between two newlines', async () => {
  const lines = ReadableStream.from(['a\n\nb\n']).pipeThrough(splitLines());

  const read = await Array.fromAsync(lines);

  expect(read).toStrictEqual(['a', '', 'b']);
});

test('it ends with no line for text that ends in a newline', async () => {
  const lines = ReadableStream.from(['a\n']).pipeThrough(splitLines());

  const read = await Array.fromAsync(lines);

  expect(read).toStrictEqual(['a']);
});
