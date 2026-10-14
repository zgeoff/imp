import { expect, test } from 'bun:test';
import { startTextCapture } from './text-capture';
import { waitFor } from './wait-for';

test('it collects every chunk as text, a character split across chunks included', async () => {
  const bytes = new TextEncoder().encode('forwarding → ready\n');

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes.slice(0, 12));
      controller.enqueue(bytes.slice(12));
      controller.close();
    },
  });

  const capture = startTextCapture(stream);

  await capture.done;

  expect(capture.read()).toBe('forwarding → ready\n');
});

test('it shows what came so far while the stream stays open', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('first\n'));
    },
  });

  const capture = startTextCapture(stream);

  const early = await waitFor('the first chunk', () => {
    const text = capture.read();

    if (text === '') {
      throw new Error('nothing yet');
    }

    return text;
  });

  expect(early).toBe('first\n');
});
