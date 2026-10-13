import { expect, test } from 'bun:test';
import { formatDuration } from './format-duration';

test.each([
  [45_000, '45s'],
  [12 * 60_000, '12m'],
  [200 * 60_000, '3h 20m'],
])('it formats %d ms as %s', (ms, expected) => {
  expect(formatDuration(ms)).toBe(expected);
});
