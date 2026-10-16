import { expect, test } from 'bun:test';
import { readQueuedText } from './read-queued-text';

test('it reads the queued text of a stream that then stays silent', async () => {
  const stream = new ReadableStream<string>({
    start: (controller) => {
      controller.enqueue('one ');
      controller.enqueue('two');
    },
  });

  const text = await readQueuedText(stream.getReader(), 50);

  expect(text).toBe('one two');
});

test('it reads a stream to its end', async () => {
  const stream = new ReadableStream<string>({
    start: (controller) => {
      controller.enqueue('all of it');
      controller.close();
    },
  });

  const text = await readQueuedText(stream.getReader(), 60_000);

  expect(text).toBe('all of it');
});

test('it reads no text from a stream that has queued none', async () => {
  const stream = new ReadableStream<string>();

  const text = await readQueuedText(stream.getReader(), 50);

  expect(text).toBe('');
});
