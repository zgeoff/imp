import { expect, test } from 'bun:test';
import { createBuildSlots } from './build-slots';

test('it gives a slot while fewer builds than the limit run', () => {
  const slots = createBuildSlots(2);

  slots.claim();

  expect(() => slots.claim()).not.toThrow();
});

test('it refuses a slot with TOO_MANY_REQUESTS when all are taken', () => {
  const slots = createBuildSlots(2);

  slots.claim();
  slots.claim();

  expect(() => slots.claim()).toThrow(
    expect.objectContaining({
      code: 'TOO_MANY_REQUESTS',
      message: '2 image builds are already uploading or running; try again',
    }),
  );
});

test('it gives a slot again once a build releases its own', () => {
  const slots = createBuildSlots(1);
  const release = slots.claim();

  release();

  expect(() => slots.claim()).not.toThrow();
});

test('it holds four slots by default', () => {
  const slots = createBuildSlots();

  slots.claim();
  slots.claim();
  slots.claim();
  slots.claim();

  expect(() => slots.claim()).toThrow(expect.objectContaining({ code: 'TOO_MANY_REQUESTS' }));
});
