import { expect, test } from 'bun:test';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { buildStubElasticGuest } from '../test-utils/build-stub-elastic-guest';
import { findShrinkTargetMib, shrinkGuest } from './shrink-guest';

test('#findShrinkTargetMib leaves the guest a step more available than its grow mark', () => {
  expect(
    findShrinkTargetMib({
      pluggedMib: 1024,
      requestedMib: 1024,
      totalMib: 1536,
      availableMib: 936,
    }),
  ).toBe(496);
});

test('#findShrinkTargetMib never goes below 0', () => {
  expect(
    findShrinkTargetMib({ pluggedMib: 512, requestedMib: 512, totalMib: 1024, availableMib: 1000 }),
  ).toBe(0);
});

test('#findShrinkTargetMib keeps 15 % of a large guest free, in whole blocks', () => {
  // (623 + 256) / 0.85 is 1034.1: 1036 in whole 2 MiB blocks, 524 of it plugged
  expect(
    findShrinkTargetMib({ pluggedMib: 512, requestedMib: 512, totalMib: 1024, availableMib: 401 }),
  ).toBe(524);
});

test('#shrinkGuest waits until the guest gets to the target', async () => {
  const clock = buildStubClock();

  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 1024,
    requestedMib: 1024,
    stepMib: 200,
  });

  const shrunk = await shrinkGuest(stub.vm, buildImpPaths('/data', 'dev'), {
    timeLimitMs: 2000,
    now: clock.now,
    sleep: clock.sleep,
  });

  expect(shrunk).toBe(496);
  expect(stub.requests).toStrictEqual([496]);
  expect(clock.now()).toBe(300);
});

test('#shrinkGuest asks an unplug that stops partway back to what it reached', async () => {
  const clock = buildStubClock();

  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 1024,
    requestedMib: 1024,
    stepMib: 200,
    floorMib: 768,
  });

  const shrunk = await shrinkGuest(stub.vm, buildImpPaths('/data', 'dev'), {
    timeLimitMs: 2000,
    now: clock.now,
    sleep: clock.sleep,
  });

  expect(shrunk).toBe(768);
  expect(stub.requests).toStrictEqual([496, 768]);

  // 768 reached at 200 ms, then 500 ms without a move
  expect(clock.now()).toBe(700);
});

test('#shrinkGuest ends a slow unplug at the time limit with what the guest holds then', async () => {
  const clock = buildStubClock();

  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 1024,
    requestedMib: 1024,
    stepMib: 16,
  });

  const shrunk = await shrinkGuest(stub.vm, buildImpPaths('/data', 'dev'), {
    timeLimitMs: 2000,
    now: clock.now,
    sleep: clock.sleep,
  });

  // 20 looks of 100 ms, each 16 MiB further down
  expect(shrunk).toBe(704);
  expect(clock.now()).toBe(2000);
  expect(stub.requests).toStrictEqual([496, 704]);
});

test('#shrinkGuest asks nothing of a guest with nothing to spare', async () => {
  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 300,
    requestedMib: 300,
    stepMib: 200,
  });

  const shrunk = await shrinkGuest(stub.vm, buildImpPaths('/data', 'dev'), {
    timeLimitMs: 2000,
  });

  expect(shrunk).toBe(300);
  expect(stub.requests).toStrictEqual([]);
});

test('#shrinkGuest counts a plug under way at its request', async () => {
  const stub = buildStubElasticGuest({
    baseMib: 512,
    usedMib: 600,
    pluggedMib: 300,
    requestedMib: 556,
    stepMib: 200,
  });

  const shrunk = await shrinkGuest(stub.vm, buildImpPaths('/data', 'dev'), {
    timeLimitMs: 2000,
  });

  expect(shrunk).toBe(556);
  expect(stub.requests).toStrictEqual([]);
});
