import { expect, test } from 'bun:test';
import { buildImpPaths } from '../storage/data-layout';
import { findShrinkTargetMib, shrinkGuest } from './shrink-guest';

const PATHS = buildImpPaths('/data', 'dev');

// A guest with 512 MiB base and 1024 plugged, using 600: it unplugs `stepMib`
// per look, down to `floorMib`. The clock moves 100 ms per look.
function setupShrinkTest(stepMib: number, floorMib = 0) {
  const clock = { now: 0 };
  const guest = { pluggedMib: 1024, requestedMib: 1024 };
  const requests: number[] = [];

  const vm = {
    readGuestMemory: () => {
      if (guest.requestedMib < guest.pluggedMib) {
        guest.pluggedMib = Math.max(guest.requestedMib, floorMib, guest.pluggedMib - stepMib);
      }

      return Promise.resolve({
        ...guest,
        totalMib: 512 + guest.pluggedMib,
        availableMib: 512 + guest.pluggedMib - 600,
      });
    },
    requestPluggedMib: (_paths: unknown, mib: number) => {
      guest.requestedMib = mib;

      requests.push(mib);

      return Promise.resolve();
    },
  };

  const options = {
    timeLimitMs: 2000,
    now: () => clock.now,
    sleep: (ms: number) => {
      clock.now += ms;

      return Promise.resolve();
    },
  };

  return { clock, guest, requests, shrink: () => shrinkGuest(vm, PATHS, options) };
}

test('the target leaves the guest a step more available than its grow mark, never below 0', () => {
  expect(
    findShrinkTargetMib({
      pluggedMib: 1024,
      requestedMib: 1024,
      totalMib: 1536,
      availableMib: 936,
    }),
  ).toBe(496);

  expect(
    findShrinkTargetMib({ pluggedMib: 512, requestedMib: 512, totalMib: 1024, availableMib: 1000 }),
  ).toBe(0);

  // 15 % of a large guest is more than 128 MiB; odd MiB round up to whole
  // blocks: (623 + 256) / 0.85 is 1034.1
  expect(
    findShrinkTargetMib({ pluggedMib: 512, requestedMib: 512, totalMib: 1024, availableMib: 401 }),
  ).toBe(524);
});

test('a shrink waits until the guest gets there', async () => {
  const ctx = setupShrinkTest(200);

  const shrunk = await ctx.shrink();

  expect(shrunk).toBe(496);
  expect(ctx.requests).toEqual([496]);
  expect(ctx.clock.now).toBe(300);
});

test('an unplug that stops partway is asked back to what it reached', async () => {
  const ctx = setupShrinkTest(200, 768);

  const shrunk = await ctx.shrink();

  expect(shrunk).toBe(768);
  expect(ctx.requests).toEqual([496, 768]);

  // 768 reached at 200 ms, then 500 ms without a move
  expect(ctx.clock.now).toBe(700);
});

test('a slow unplug ends at the time limit with what the guest holds then', async () => {
  const ctx = setupShrinkTest(16);

  const shrunk = await ctx.shrink();

  expect(ctx.clock.now).toBe(2000);
  expect(shrunk).toBe(1024 - 16 * 20);
  expect(ctx.requests).toEqual([496, 704]);
  expect(ctx.guest.requestedMib).toBe(704);
});

test('a guest with nothing to spare is not asked', async () => {
  const ctx = setupShrinkTest(200);

  ctx.guest.pluggedMib = 300;
  ctx.guest.requestedMib = 300;

  const shrunk = await ctx.shrink();

  expect(shrunk).toBe(300);
  expect(ctx.requests).toEqual([]);
});

test('a plug under way counts at its request: the guest may hold that much by the pause', async () => {
  const ctx = setupShrinkTest(200);

  ctx.guest.pluggedMib = 300;
  ctx.guest.requestedMib = 556;

  const shrunk = await ctx.shrink();

  expect(shrunk).toBe(556);
  expect(ctx.requests).toEqual([]);
});
