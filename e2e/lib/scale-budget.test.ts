import { expect, mock, onTestFinished, test } from 'bun:test';
import { buildStubAnswerQueue } from '@imp/test-utils/build-stub-answer-queue';
import { buildStubClock } from '../../packages/daemon/src/test-utils/build-stub-clock';
import type { BudgetSample } from './scale-budget';
import {
  buildFillScript,
  buildOvershootLimits,
  findBudgetViolations,
  readOvershootMs,
  startBudgetMonitor,
  waitForSampleAfter,
  waitForUnderBudget,
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

test('#startBudgetMonitor keeps each sample it reads and passes over one impd was too busy to give', async () => {
  const first = {
    at: 100,
    ramUsedMib: 900,
    awake: 3,
    firecrackerPssMib: 950,
    firecrackerOwnedMib: 900,
  };

  const second = {
    at: 600,
    ramUsedMib: 950,
    awake: 3,
    firecrackerPssMib: 990,
    firecrackerOwnedMib: 940,
  };

  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<BudgetSample | null>();

  // the reads in turn; the last holds until the test lets it go
  const reads = buildStubAnswerQueue<() => Promise<BudgetSample | null>>([
    () => Promise.resolve(first),
    () => Promise.resolve(null),
    () => Promise.resolve(second),
    () => {
      reached.resolve();

      return gate.promise;
    },
  ]);

  const watch = { sleeps: [], stop: mock(() => Promise.resolve()) };

  const monitor = await startBudgetMonitor({
    readSample: () => reads.next()(),
    startWatch: () => Promise.resolve(watch),
    wait: () => Promise.resolve(),
  });

  onTestFinished(() => {
    gate.resolve(null);

    return monitor.stop();
  });

  await reached.promise;

  const stopped = monitor.stop();

  gate.resolve(null);

  await stopped;

  expect(monitor.samples).toStrictEqual([first, second]);
  expect(watch.stop).toHaveBeenCalledOnce();
});

test('#startBudgetMonitor stops at a failed read, stops the sleep watch, and rethrows the failure on stop', async () => {
  const watch = { sleeps: [], stop: mock(() => Promise.resolve()) };

  const monitor = await startBudgetMonitor({
    readSample: () => Promise.reject(new Error('smaps read failed')),
    startWatch: () => Promise.resolve(watch),
    wait: () => Promise.resolve(),
  });

  expect(monitor.stop()).rejects.toThrowWithMessage(Error, 'smaps read failed');
  expect(watch.stop).toHaveBeenCalledOnce();
});

test('#startBudgetMonitor stops the sampler and the sleep watch once when stop is called again', async () => {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<BudgetSample | null>();
  const watch = { sleeps: [], stop: mock(() => Promise.resolve()) };

  const monitor = await startBudgetMonitor({
    readSample: () => {
      reached.resolve();

      return gate.promise;
    },
    startWatch: () => Promise.resolve(watch),
    wait: () => Promise.resolve(),
  });

  onTestFinished(() => {
    gate.resolve(null);

    return monitor.stop();
  });

  await reached.promise;

  const stops = [monitor.stop(), monitor.stop()];

  gate.resolve(null);

  await Promise.all(stops);

  expect(watch.stop).toHaveBeenCalledOnce();
});

test('#waitForSampleAfter waits until a sample lands the given time past the start', async () => {
  const clock = buildStubClock();

  const samples = [
    { at: 100, ramUsedMib: 900, awake: 3, firecrackerPssMib: 950, firecrackerOwnedMib: 900 },
  ];

  clock.startTimer(() => {
    samples.push({
      at: 700,
      ramUsedMib: 900,
      awake: 3,
      firecrackerPssMib: 950,
      firecrackerOwnedMib: 900,
    });
  }, 700);

  await waitForSampleAfter({ samples, sleeps: [], stop: () => Promise.resolve() }, 0, 600, {
    now: clock.now,
    wait: clock.sleep,
  });

  expect(clock.now()).toBe(1000);
});

test('#waitForSampleAfter rejects when no sample lands past the start before the deadline', () => {
  const clock = buildStubClock();

  const samples = [
    { at: 100, ramUsedMib: 900, awake: 3, firecrackerPssMib: 950, firecrackerOwnedMib: 900 },
  ];

  expect(
    waitForSampleAfter({ samples, sleeps: [], stop: () => Promise.resolve() }, 0, 600, {
      now: clock.now,
      wait: clock.sleep,
    }),
  ).rejects.toThrowWithMessage(
    Error,
    'timed out after 60000 ms waiting for a budget sample 600 ms after 0: last sample at 100',
  );
});

test('#waitForUnderBudget returns once both figures of the last sample are under the budget', async () => {
  const clock = buildStubClock();

  const samples = [
    { at: 0, ramUsedMib: 1100, awake: 3, firecrackerPssMib: 1150, firecrackerOwnedMib: 1100 },
  ];

  clock.startTimer(() => {
    samples.push({
      at: 700,
      ramUsedMib: 900,
      awake: 2,
      firecrackerPssMib: 950,
      firecrackerOwnedMib: 990,
    });
  }, 700);

  await waitForUnderBudget(
    { samples, sleeps: [], stop: () => Promise.resolve() },
    { budgetMib: 1000, maxStartMs: 2500, maxOverMib: 100 },
    { now: clock.now, wait: clock.sleep },
  );

  expect(clock.now()).toBe(1000);
});

test('#waitForUnderBudget returns without failing once an overshoot outlasts the start limit and the longest sleep', async () => {
  const clock = buildStubClock();

  // impd's figure is under, what the VMs own is not
  const samples = [
    { at: 0, ramUsedMib: 900, awake: 3, firecrackerPssMib: 1150, firecrackerOwnedMib: 1100 },
  ];

  await waitForUnderBudget(
    { samples, sleeps: [], stop: () => Promise.resolve() },
    { budgetMib: 1000, maxStartMs: 2500, maxOverMib: 100 },
    { now: clock.now, wait: clock.sleep },
  );

  // the start limit plus budget-overshoot.ts's 30 s MAX_SLEEP_MS
  expect(clock.now()).toBe(32_500);
});
