import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { createCountedLimit } from './counted-limit';

test('it grants claims on a key up to the limit', () => {
  const limit = createCountedLimit(2);

  limit.tryClaim('a');
  limit.tryClaim('a');

  expect(limit.countHeld('a')).toBe(2);
});

test('it refuses a claim past the limit', () => {
  const limit = createCountedLimit(2);

  limit.tryClaim('a');
  limit.tryClaim('a');

  expect(limit.tryClaim('a')).toBeNull();
});

test('it counts each key apart', () => {
  const limit = createCountedLimit(1);

  limit.tryClaim('a');

  expect(limit.tryClaim('b')).not.toBeNull();
});

test('it grants a claim again once one is released', () => {
  const limit = createCountedLimit(1);
  const release = limit.tryClaim('a');

  invariant(release);
  release();

  expect(limit.tryClaim('a')).not.toBeNull();
});

test('it releases a claim only once however often its release is called', () => {
  const limit = createCountedLimit(2);
  const release = limit.tryClaim('a');

  invariant(release);

  limit.tryClaim('a');

  release();
  release();

  expect(limit.countHeld('a')).toBe(1);
});

test('it reports a key full only at the limit', () => {
  const limit = createCountedLimit(2);

  limit.tryClaim('a');

  expect(limit.isFull('a')).toBeFalse();
});

test('it reports a key full once it holds the limit', () => {
  const limit = createCountedLimit(1);

  limit.tryClaim('a');

  expect(limit.isFull('a')).toBeTrue();
});
