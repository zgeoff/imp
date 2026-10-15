import { expect, test } from 'bun:test';
import { buildPercentile, buildStats } from './stats';

test.each([
  [50, 3],
  [95, 5],
  [1, 1],
])('#buildPercentile picks the nearest rank for p%d of five samples, %d', (p, expected) => {
  expect(buildPercentile([5, 1, 4, 2, 3], p)).toBe(expected);
});

test('#buildPercentile returns null for no samples', () => {
  expect(buildPercentile([], 50)).toBeNull();
});

test('#buildStats summarizes no samples as nulls', () => {
  expect(buildStats([])).toStrictEqual({ n: 0, p50: null, p95: null, max: null });
});

test('#buildStats summarizes a series of timings by nearest rank', () => {
  const samples = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);

  expect(buildStats(samples)).toStrictEqual({ n: 20, p50: 100, p95: 190, max: 200 });
});
