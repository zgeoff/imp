import { expect, test } from 'bun:test';
import { findBudgetBreaches, findOvershoots } from './budget-overshoot';

const LIMITS = { budgetMib: 2816, maxStartMs: 5500, maxOverMib: 256 };

// samples 700 ms apart, as the scale monitor takes them
function buildSamples(usedMib: readonly number[]) {
  return usedMib.map((mib, index) => ({ at: index * 700, usedMib: mib }));
}

function buildOver(count: number, mib = 2830): number[] {
  return Array.from({ length: count }, () => mib);
}

test('an overshoot that ends inside the start limit passes, whatever ended it', () => {
  // measured in the scale suite: 9 MiB over for two samples, ended by the
  // admission sleep of another imp
  const samples = buildSamples([2741, 2825, 2825, 2517, 2648]);
  const admission = { startAt: 600, endAt: 1800, isEnforce: false };

  expect(findOvershoots(samples, LIMITS.budgetMib)).toEqual([
    { samples: samples.slice(1, 3), maxOverMib: 9, isOpen: false },
  ]);

  expect(findBudgetBreaches(samples, [admission], LIMITS)).toBeEmpty();
});

test('a slow enforce sleep passes: its own length does not count against the overshoot', () => {
  // over from 700 ms; enforce starts a sleep at 5.6 s that takes 2.4 s, so use
  // is over for 7.7 s in all
  const samples = buildSamples([2700, ...buildOver(11), 2500]);
  const enforce = { startAt: 5600, endAt: 8000, isEnforce: true };

  expect(findBudgetBreaches(samples, [enforce], LIMITS)).toBeEmpty();
});

test('a missing enforce sleep fails once use stays over past the start limit', () => {
  const samples = buildSamples([2700, ...buildOver(10), 2700]);

  expect(findBudgetBreaches(samples, [], LIMITS)).toEqual([
    { startAt: 700, maxOverMib: 14, why: 'no enforce sleep started within 5500 ms' },
  ]);
});

test('a dead enforce loop fails even with admission sleeps around it', () => {
  // creates every 4 s sleep an imp each to make room, never enough to bring
  // use under the budget, and enforce never runs
  const samples = buildSamples([2700, ...buildOver(16), 2700]);

  const admissions = [0, 4000, 8000].map((startAt) => ({
    startAt,
    endAt: startAt + 1000,
    isEnforce: false,
  }));

  expect(findBudgetBreaches(samples, admissions, LIMITS)).toHaveLength(1);
});

test('an enforce sleep that starts after the start limit counts as missing', () => {
  const samples = buildSamples([2700, ...buildOver(12), 2700]);
  const late = { startAt: 7000, endAt: 8400, isEnforce: true };

  expect(findBudgetBreaches(samples, [late], LIMITS)).toHaveLength(1);
});

test('use still over after the enforce sleep ended fails', () => {
  const samples = buildSamples([2700, ...buildOver(10), 2700]);
  const enforce = { startAt: 3000, endAt: 4000, isEnforce: true };

  expect(findBudgetBreaches(samples, [enforce], LIMITS)).toEqual([
    {
      startAt: 700,
      maxOverMib: 14,
      why: 'still over after the enforce sleep that ended 3300 ms in',
    },
  ]);
});

test('an enforce sleep that took longer than 30 s fails as hung', () => {
  const samples = buildSamples([2700, ...buildOver(50), 2700]);
  const hung = { startAt: 5000, endAt: 36_000, isEnforce: true };

  expect(findBudgetBreaches(samples, [hung], LIMITS)).toEqual([
    { startAt: 700, maxOverMib: 14, why: 'the enforce sleep took 31000 ms' },
  ]);
});

test('an open overshoot waits for a sleep under way, up to 30 s past the start limit', () => {
  const pending = buildSamples([2700, ...buildOver(12)]);
  const hung = buildSamples([2700, ...buildOver(60)]);

  expect(findBudgetBreaches(pending, [], LIMITS)).toBeEmpty();
  expect(findBudgetBreaches(hung, [], LIMITS)).toHaveLength(1);
});

test('an overshoot past the most a guest grows over its reserve fails, sleep or not', () => {
  const samples = buildSamples([2700, 3100, 2700]);

  expect(findBudgetBreaches(samples, [], LIMITS)).toEqual([
    {
      startAt: 700,
      maxOverMib: 284,
      why: 'over by more than a guest grows past its reserve (256 MiB)',
    },
  ]);
});
