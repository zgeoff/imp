import { expect, test } from 'bun:test';
import { buildPercentile, buildStats } from './stats';

test('it picks the nearest rank, not an interpolated value', () => {
  const samples = [5, 1, 4, 2, 3];

  expect(buildPercentile(samples, 50)).toBe(3);
  expect(buildPercentile(samples, 95)).toBe(5);
  expect(buildPercentile(samples, 1)).toBe(1);
});

test('it returns null for no samples', () => {
  expect(buildPercentile([], 50)).toBeNull();
  expect(buildStats([])).toEqual({ n: 0, p50: null, p95: null, max: null });
});

test('it summarizes a series of timings', () => {
  const samples = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);

  expect(buildStats(samples)).toEqual({ n: 20, p50: 100, p95: 190, max: 200 });
});
