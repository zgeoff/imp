import { expect, test } from 'bun:test';
import { buildBackoffMs } from './build-backoff-ms';

test.each([
  [0, 0],
  [1, 1000],
  [2, 2000],
  [3, 4000],
  [4, 5000],
  [10, 5000],
])('it waits after %d failures %d ms with a 1 s base and a 5 s cap', (failures, expected) => {
  expect(buildBackoffMs(failures, { baseMs: 1000, capMs: 5000 })).toBe(expected);
});

test('it doubles without end when the cap is Infinity', () => {
  expect(buildBackoffMs(20, { baseMs: 1, capMs: Number.POSITIVE_INFINITY })).toBe(524_288);
});
