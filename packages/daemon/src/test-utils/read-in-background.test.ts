import { expect, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { readInBackground } from './read-in-background';

test('it keeps each item as the source sends it, before the source ends', async () => {
  const gate = Promise.withResolvers<void>();

  const reading = readInBackground(
    (async function* sendTwo() {
      yield 'first';

      await gate.promise;

      yield 'second';
    })(),
  );

  await waitFor(() => {
    if (reading.items.length === 0) {
      throw new Error('no item yet');
    }
  });

  const before = [...reading.items];

  gate.resolve();

  await reading.ended;

  expect(before).toStrictEqual(['first']);
  expect(reading.items).toStrictEqual(['first', 'second']);
});

test('it ends with null when the source ends on its own', async () => {
  const reading = readInBackground(
    new ReadableStream<number>({
      start: (controller) => {
        controller.enqueue(1);
        controller.close();
      },
    }),
  );

  const ended = await reading.ended;

  expect(ended).toBeNull();
});

test('it ends with the error the source threw', async () => {
  const reading = readInBackground(
    new ReadableStream<number>({
      start: (controller) => {
        controller.enqueue(1);
        controller.error(new Error('cut'));
      },
    }),
  );

  const ended = await reading.ended;

  expect(ended).toBeInstanceOf(Error);
  expect(ended).toMatchObject({ message: 'cut' });
});
