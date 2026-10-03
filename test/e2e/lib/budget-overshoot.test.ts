import { expect, test } from 'bun:test';
import { findBudgetBreaches, findOvershoots } from './budget-overshoot';

const LIMITS = { budgetMib: 2816, maxStartMs: 5500, maxOverMib: 256 };

// samples 700 ms apart, as the scale monitor takes them
function buildSamples(usedMib: readonly number[]) {
  return usedMib.map((mib, index) => ({ at: index * 700, usedMib: mib }));
}

test('an overshoot that a sleep under way ends passes', () => {
  // measured in the scale suite: 9 MiB over for two samples, ended by the
  // admission sleep of another imp
  const samples = buildSamples([2741, 2825, 2825, 2517, 2648]);

  expect(findOvershoots(samples, LIMITS.budgetMib)).toEqual([
    { samples: samples.slice(1, 3), maxOverMib: 9 },
  ]);

  expect(findBudgetBreaches(samples, [{ startAt: 600, endAt: 1800 }], LIMITS)).toBeEmpty();
});

test('a slow sleep passes: its own length does not count against the overshoot', () => {
  // over from 700 ms; the enforce pass starts a sleep at 5.6 s, which takes
  // 2.4 s, so use is over for 7.7 s in all
  const samples = buildSamples([2700, ...Array.from({ length: 11 }, () => 2830), 2500]);

  expect(findBudgetBreaches(samples, [{ startAt: 5600, endAt: 8000 }], LIMITS)).toBeEmpty();
});

test('a missing sleep fails once use stays over past the start limit', () => {
  const samples = buildSamples([2700, ...Array.from({ length: 10 }, () => 2830), 2700]);

  expect(findBudgetBreaches(samples, [], LIMITS)).toEqual([
    { startAt: 700, maxOverMib: 14, why: 'no sleep started within 5500 ms' },
  ]);
});

test('a sleep that starts after the start limit counts as missing', () => {
  const samples = buildSamples([2700, ...Array.from({ length: 12 }, () => 2830), 2700]);

  expect(findBudgetBreaches(samples, [{ startAt: 7000, endAt: 8400 }], LIMITS)).toHaveLength(1);
});

test('use still over after the sleep ended fails', () => {
  const samples = buildSamples([2700, 2830, 2830, 2830, 2830, 2700]);

  expect(findBudgetBreaches(samples, [{ startAt: 1000, endAt: 2000 }], LIMITS)).toEqual([
    { startAt: 700, maxOverMib: 14, why: 'still over after the sleep that ended 1300 ms in' },
  ]);
});

test('an overshoot still inside the start limit at the last sample passes for now', () => {
  const samples = buildSamples([2700, 2830, 2830, 2830]);

  expect(findBudgetBreaches(samples, [], LIMITS)).toBeEmpty();
});

test('an overshoot larger than one boot reserve fails, sleep or not', () => {
  const samples = buildSamples([2700, 3100, 2700]);

  expect(findBudgetBreaches(samples, [{ startAt: 0, endAt: 1000 }], LIMITS)).toEqual([
    { startAt: 700, maxOverMib: 284, why: 'over by more than one boot reserve (256 MiB)' },
  ]);
});
