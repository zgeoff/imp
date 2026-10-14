import { expect, test } from 'bun:test';
import { findBudgetBreaches, findOvershoots } from './budget-overshoot';

// Samples are 700 ms apart, as the scale monitor takes them.

test('#findOvershoots finds a run of samples over the budget that use left again', () => {
  // measured in the scale suite: 9 MiB over for two samples
  const samples = [2741, 2825, 2825, 2517, 2648].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  expect(findOvershoots(samples, 2816)).toStrictEqual([
    {
      samples: [
        { at: 700, usedMib: 2825 },
        { at: 1400, usedMib: 2825 },
      ],
      maxOverMib: 9,
      isOpen: false,
    },
  ]);
});

test('#findOvershoots marks a run still over at the last sample as open', () => {
  const samples = [2700, 2830].map((usedMib, index) => ({ at: index * 700, usedMib }));

  expect(findOvershoots(samples, 2816)).toStrictEqual([
    { samples: [{ at: 700, usedMib: 2830 }], maxOverMib: 14, isOpen: true },
  ]);
});

test('#findBudgetBreaches passes an overshoot that ends inside the start limit, whatever ended it', () => {
  // ended by the admission sleep of another imp
  const samples = [2741, 2825, 2825, 2517, 2648].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(samples, [{ startAt: 600, endAt: 1800, isEnforce: false }], {
    budgetMib: 2816,
    maxStartMs: 5500,
    maxOverMib: 256,
  });

  expect(breaches).toBeEmpty();
});

test('#findBudgetBreaches passes a slow enforce sleep, whose own length does not count against the overshoot', () => {
  // over from 700 ms; enforce starts a sleep at 5.6 s that takes 2.4 s, so use
  // is over for 7.7 s in all
  const samples = [2700, ...Array.from({ length: 11 }, () => 2830), 2500].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(samples, [{ startAt: 5600, endAt: 8000, isEnforce: true }], {
    budgetMib: 2816,
    maxStartMs: 5500,
    maxOverMib: 256,
  });

  expect(breaches).toBeEmpty();
});

test('#findBudgetBreaches fails a missing enforce sleep once use stays over past the start limit', () => {
  const samples = [2700, ...Array.from({ length: 10 }, () => 2830), 2700].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(samples, [], {
    budgetMib: 2816,
    maxStartMs: 5500,
    maxOverMib: 256,
  });

  expect(breaches).toStrictEqual([
    { startAt: 700, maxOverMib: 14, why: 'no enforce sleep started within 5500 ms' },
  ]);
});

test('#findBudgetBreaches fails a dead enforce loop even with admission sleeps around it', () => {
  // creates every 4 s sleep an imp each to make room, never enough to bring
  // use under the budget, and enforce never runs
  const samples = [2700, ...Array.from({ length: 16 }, () => 2830), 2700].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(
    samples,
    [
      { startAt: 0, endAt: 1000, isEnforce: false },
      { startAt: 4000, endAt: 5000, isEnforce: false },
      { startAt: 8000, endAt: 9000, isEnforce: false },
    ],
    { budgetMib: 2816, maxStartMs: 5500, maxOverMib: 256 },
  );

  expect(breaches).toStrictEqual([
    { startAt: 700, maxOverMib: 14, why: 'no enforce sleep started within 5500 ms' },
  ]);
});

test('#findBudgetBreaches counts an enforce sleep that starts after the start limit as missing', () => {
  const samples = [2700, ...Array.from({ length: 12 }, () => 2830), 2700].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(samples, [{ startAt: 7000, endAt: 8400, isEnforce: true }], {
    budgetMib: 2816,
    maxStartMs: 5500,
    maxOverMib: 256,
  });

  expect(breaches).toStrictEqual([
    { startAt: 700, maxOverMib: 14, why: 'no enforce sleep started within 5500 ms' },
  ]);
});

test('#findBudgetBreaches fails use still over after the enforce sleep ended', () => {
  const samples = [2700, ...Array.from({ length: 10 }, () => 2830), 2700].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(samples, [{ startAt: 3000, endAt: 4000, isEnforce: true }], {
    budgetMib: 2816,
    maxStartMs: 5500,
    maxOverMib: 256,
  });

  expect(breaches).toStrictEqual([
    {
      startAt: 700,
      maxOverMib: 14,
      why: 'still over after the enforce sleep that ended 3300 ms in',
    },
  ]);
});

test('#findBudgetBreaches fails an enforce sleep that took longer than 30 s as hung', () => {
  const samples = [2700, ...Array.from({ length: 50 }, () => 2830), 2700].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(
    samples,
    [{ startAt: 5000, endAt: 36_000, isEnforce: true }],
    { budgetMib: 2816, maxStartMs: 5500, maxOverMib: 256 },
  );

  expect(breaches).toStrictEqual([
    { startAt: 700, maxOverMib: 14, why: 'the enforce sleep took 31000 ms' },
  ]);
});

test('#findBudgetBreaches lets an open overshoot wait for a sleep under way inside 30 s past the start limit', () => {
  const samples = [2700, ...Array.from({ length: 12 }, () => 2830)].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(samples, [], {
    budgetMib: 2816,
    maxStartMs: 5500,
    maxOverMib: 256,
  });

  expect(breaches).toBeEmpty();
});

test('#findBudgetBreaches fails an open overshoot still waiting more than 30 s past the start limit', () => {
  const samples = [2700, ...Array.from({ length: 60 }, () => 2830)].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(samples, [], {
    budgetMib: 2816,
    maxStartMs: 5500,
    maxOverMib: 256,
  });

  expect(breaches).toStrictEqual([
    { startAt: 700, maxOverMib: 14, why: 'no enforce sleep started within 5500 ms' },
  ]);
});

test('#findBudgetBreaches fails an overshoot past the most a guest grows over its reserve, sleep or not', () => {
  const samples = [2700, 3100, 2700].map((usedMib, index) => ({ at: index * 700, usedMib }));

  const breaches = findBudgetBreaches(samples, [], {
    budgetMib: 2816,
    maxStartMs: 5500,
    maxOverMib: 256,
  });

  expect(breaches).toStrictEqual([
    {
      startAt: 700,
      maxOverMib: 284,
      why: 'over by more than a guest grows past its reserve (256 MiB)',
    },
  ]);
});

test('#findBudgetBreaches passes a running check of an overshoot still inside the grace for a sleep under way', () => {
  const samples = [2700, ...Array.from({ length: 12 }, () => 2830)].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(
    samples,
    [{ startAt: 0, endAt: 1000, isEnforce: false }],
    { budgetMib: 2816, maxStartMs: 5500, maxOverMib: 256 },
    'running',
  );

  expect(breaches).toBeEmpty();
});

test("#findBudgetBreaches fails the final check of a dead enforce loop's overshoot still open at the end", () => {
  // the last sample is inside the grace a running check gives a sleep under way
  const samples = [2700, ...Array.from({ length: 12 }, () => 2830)].map((usedMib, index) => ({
    at: index * 700,
    usedMib,
  }));

  const breaches = findBudgetBreaches(
    samples,
    [{ startAt: 0, endAt: 1000, isEnforce: false }],
    { budgetMib: 2816, maxStartMs: 5500, maxOverMib: 256 },
    'final',
  );

  expect(breaches).toStrictEqual([
    { startAt: 700, maxOverMib: 14, why: 'still over the budget when the run ended' },
  ]);
});

test('#findBudgetBreaches passes the final check of a run that ends under the budget', () => {
  const samples = [2700, 2825, 2600].map((usedMib, index) => ({ at: index * 700, usedMib }));

  const breaches = findBudgetBreaches(
    samples,
    [],
    { budgetMib: 2816, maxStartMs: 5500, maxOverMib: 256 },
    'final',
  );

  expect(breaches).toBeEmpty();
});
