import { expect, test } from 'bun:test';
import {
  buildFillScript,
  buildOvershootLimits,
  findBudgetViolations,
  readOvershootMs,
} from './scale-budget';

test('#buildFillScript fills a tmpfs 16 MiB larger than the fill with random data', () => {
  expect(buildFillScript(256)).toBe(
    'mkdir -p /run/fill && mount -t tmpfs -o size=272m tmpfs /run/fill && ' +
      'dd if=/dev/urandom of=/run/fill/blob bs=1M count=256 2>/dev/null',
  );
});

test('#buildOvershootLimits allows one enforce period and one sample, and the memory the reserve leaves out', () => {
  expect(
    buildOvershootLimits({
      budgetMib: 4096,
      memoryMib: 512,
      reservePercent: 50,
      enforceIntervalMs: 1000,
    }),
  ).toStrictEqual({ budgetMib: 4096, maxStartMs: 1500, maxOverMib: 256 });
});

test('#buildOvershootLimits rounds the part the reserve leaves out up to a whole MiB', () => {
  expect(
    buildOvershootLimits({
      budgetMib: 4096,
      memoryMib: 513,
      reservePercent: 50,
      enforceIntervalMs: 1000,
    }).maxOverMib,
  ).toBe(257);
});

test('#findBudgetViolations names a breach in what the VMs own that impd’s figure hides', () => {
  const samples = [
    { at: 0, ramUsedMib: 900, awake: 3, firecrackerPssMib: 1100, firecrackerOwnedMib: 900 },
    { at: 500, ramUsedMib: 950, awake: 3, firecrackerPssMib: 1500, firecrackerOwnedMib: 1400 },
    { at: 1000, ramUsedMib: 950, awake: 3, firecrackerPssMib: 1500, firecrackerOwnedMib: 1400 },
  ];

  expect(
    findBudgetViolations(
      samples,
      [],
      { budgetMib: 1000, maxStartMs: 1500, maxOverMib: 256 },
      'running',
    ),
  ).toStrictEqual([
    'Firecracker owned 400 MiB over the budget: over by more than a guest grows past its reserve (256 MiB)',
  ]);
});

test('#findBudgetViolations names an overshoot still open at the final check in both figures', () => {
  const samples = [
    { at: 0, ramUsedMib: 900, awake: 3, firecrackerPssMib: 900, firecrackerOwnedMib: 900 },
    { at: 500, ramUsedMib: 1100, awake: 3, firecrackerPssMib: 1200, firecrackerOwnedMib: 1050 },
  ];

  expect(
    findBudgetViolations(
      samples,
      [],
      { budgetMib: 1000, maxStartMs: 1500, maxOverMib: 256 },
      'final',
    ),
  ).toStrictEqual([
    'ramUsedMib 100 MiB over the budget: still over the budget when the run ended',
    'Firecracker owned 50 MiB over the budget: still over the budget when the run ended',
  ]);
});

test('#findBudgetViolations passes samples that stay inside the budget', () => {
  const samples = [
    { at: 0, ramUsedMib: 900, awake: 3, firecrackerPssMib: 1200, firecrackerOwnedMib: 950 },
  ];

  expect(
    findBudgetViolations(
      samples,
      [],
      { budgetMib: 1000, maxStartMs: 1500, maxOverMib: 256 },
      'final',
    ),
  ).toStrictEqual([]);
});

test('#readOvershootMs measures from the first sample over the budget to the last', () => {
  const overshoot = {
    samples: [
      { at: 1000, usedMib: 1100 },
      { at: 1500, usedMib: 1200 },
      { at: 2500, usedMib: 1050 },
    ],
    maxOverMib: 200,
    isOpen: false,
  };

  expect(readOvershootMs(overshoot)).toBe(1500);
});
