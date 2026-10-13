import { expect, test } from 'bun:test';
import { splitLines } from './split-lines';

test('it splits lines that span and share chunks', async () => {
  const text = new ReadableStream<string>({
    start: (controller) => {
      controller.enqueue('one\ntw');
      controller.enqueue('o\nthree\n');
      controller.enqueue('four');
      controller.close();
    },
  });

  const read = await Array.fromAsync(text.pipeThrough(splitLines()));

  expect(read).toStrictEqual(['one', 'two', 'three', 'four']);
});

test('it keeps an empty line between two newlines', async () => {
  const text = new ReadableStream<string>({
    start: (controller) => {
      controller.enqueue('a\n\nb\n');
      controller.close();
    },
  });

  const read = await Array.fromAsync(text.pipeThrough(splitLines()));

  expect(read).toStrictEqual(['a', '', 'b']);
});

test('it ends with no line for text that ends in a newline', async () => {
  const text = new ReadableStream<string>({
    start: (controller) => {
      controller.enqueue('a\n');
      controller.close();
    },
  });

  const read = await Array.fromAsync(text.pipeThrough(splitLines()));

  expect(read).toStrictEqual(['a']);
});
