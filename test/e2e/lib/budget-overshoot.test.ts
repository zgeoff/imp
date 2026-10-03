import { expect, test } from 'bun:test';
import { findBudgetBreaches, findOvershoots } from './budget-overshoot';

const LIMITS = { budgetMib: 2816, maxMs: 5500, maxOverMib: 256 };

// samples 700 ms apart, as the scale monitor takes them
function buildSamples(usedMib: readonly number[]) {
  return usedMib.map((mib, index) => ({ at: index * 700, usedMib: mib }));
}

test('a transient overshoot the governor ends within the limits passes', () => {
  // measured in the scale suite: 9 MiB over for two samples
  const samples = buildSamples([2741, 2825, 2825, 2517, 2648]);

  expect(findOvershoots(samples, LIMITS.budgetMib)).toEqual([
    { startAt: 700, ms: 700, maxOverMib: 9 },
  ]);

  expect(findBudgetBreaches(samples, LIMITS)).toBeEmpty();
});

test('use that stays over for longer than the limit fails', () => {
  const samples = buildSamples([2700, ...Array.from({ length: 10 }, () => 2830), 2700]);

  expect(findBudgetBreaches(samples, LIMITS)).toEqual([{ startAt: 700, ms: 6300, maxOverMib: 14 }]);
});

test('use still over the budget at the last sample counts to that sample', () => {
  const samples = buildSamples([2700, ...Array.from({ length: 10 }, () => 2830)]);

  expect(findBudgetBreaches(samples, LIMITS)).toHaveLength(1);
});

test('an overshoot larger than one boot reserve fails however short', () => {
  const samples = buildSamples([2700, 3100, 2700]);

  expect(findBudgetBreaches(samples, LIMITS)).toEqual([{ startAt: 700, ms: 0, maxOverMib: 284 }]);
});

test('each run over the budget is its own overshoot', () => {
  const samples = buildSamples([2820, 2700, 2830, 2840, 2700]);

  expect(findOvershoots(samples, LIMITS.budgetMib)).toEqual([
    { startAt: 0, ms: 0, maxOverMib: 4 },
    { startAt: 1400, ms: 700, maxOverMib: 24 },
  ]);
});
