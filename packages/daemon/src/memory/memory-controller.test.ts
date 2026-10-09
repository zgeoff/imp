import { expect, mock, test } from 'bun:test';
import { buildMockElasticImp } from '../test-utils/build-mock-elastic-imp';
import { buildStubGuestMemory } from '../test-utils/build-stub-guest-memory';
import { createMemoryController } from './memory-controller';
import type { ElasticImp, MemoryControllerDeps } from './memory-controller';

// The controller's deps on stand-in guests, a clock the test moves, and a
// record of every call it made: it admits each grow, finds no imp busy or
// locked, and runs each plug.
function setupTest() {
  const clock = { now: 0 };
  const guests = buildStubGuestMemory();
  const imps: ElasticImp[] = [];
  const limits: string[] = [];
  const grows: { id: string; mib: number }[] = [];
  const releases: string[] = [];
  const logs: string[] = [];

  const plugged = new Map<string, number>();

  // the RAM each VM owns is the test's to give, as `readRamMib`
  const deps: Omit<MemoryControllerDeps, 'readRamMib'> = {
    listElastic: () => Promise.resolve(imps),
    vms: guests.vms,
    isLocked: () => false,
    isBusy: () => false,
    tryWhileRunning: async (_id, action) => {
      await action();

      return true;
    },
    admitGrow: (request) => {
      grows.push({ id: request.id, mib: request.mib });

      return Promise.resolve(true);
    },
    releaseGrow: (id) => {
      releases.push(id);
    },
    limit: {
      setGuestMib: (id, guestMib) => {
        limits.push(`${id} ${String(guestMib)}`);
      },
    },
    setPluggedMib: (id, mib) => {
      if (mib === null) {
        plugged.delete(id);
      } else {
        plugged.set(id, mib);
      }
    },
    log: (message) => {
      logs.push(message);
    },
    now: () => clock.now,
    sleep: () => Promise.resolve(),
  };

  return {
    deps,
    guests,
    imps,
    limits,
    grows,
    releases,
    logs,
    plugged,
    advance: (ms: number) => {
      clock.now += ms;
    },
  };
}

test('it grows a guest low on memory by a step, its limit raised before the plug', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { usedMib: 490 });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();

  // 256 MiB and its 4 MiB of struct pages
  expect(ctx.grows).toStrictEqual([{ id: 'dev', mib: 260 }]);
  expect(ctx.limits).toStrictEqual(['dev 512', 'dev 768']);
  expect(ctx.guests.requests).toStrictEqual([256]);
});

test('it records what a grown guest holds without growing it again', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  const guest = ctx.guests.addGuest(imp.paths, { usedMib: 490 });
  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();
  await controller.runTick();

  expect(guest.pluggedMib).toBe(256);
  expect(ctx.plugged.get('dev')).toBe(256);
  expect(ctx.grows).toHaveLength(1);
});

test('it grows a guest step by step to its max and no further', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1000,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  // 488 MiB of growth to the max, in whole 128 MiB slots
  const guest = ctx.guests.addGuest(imp.paths, { usedMib: 2000, regionMib: 512 });
  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  for (let tick = 0; tick < 5; tick += 1) {
    await controller.runTick();
  }

  // the region is whole slots (512), but the max (1000) caps it: 256 + 232
  expect(ctx.guests.requests).toStrictEqual([256, 488]);
  expect(guest.pluggedMib).toBe(488);
});

test('it leaves a guest whose grow is refused at its size, and logs it once', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  const admitGrow = mock(() => Promise.resolve(false));

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { usedMib: 500 });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400, admitGrow });

  await controller.runTick();
  await controller.runTick();

  expect(ctx.guests.requests).toStrictEqual([]);
  expect(admitGrow).toHaveBeenCalledTimes(2);
  expect(ctx.limits).toStrictEqual(['dev 512']);
  expect(ctx.logs.filter((line) => line.includes('no room to grow'))).toHaveLength(1);
});

test.each([
  ['predates elastic memory', '0.16.0'],
  ['impd has no record of', undefined],
])('it never grows a guest whose agent %s, and logs why once', async (_label, agentVersion) => {
  const ctx = setupTest();
  const imp = buildMockElasticImp({ id: 'dev', memoryMib: 512, maxMemoryMib: 1536, agentVersion });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { usedMib: 490 });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();
  await controller.runTick();

  expect(ctx.grows).toStrictEqual([]);
  expect(ctx.guests.requests).toStrictEqual([]);

  const refusals = ctx.logs.filter((line) => line.includes('not grown'));

  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toContain('stop and start the imp');
});

test('it waits for a plug under way and never asks twice', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { usedMib: 500, isSlow: true });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();
  await controller.runTick();

  expect(ctx.guests.requests).toStrictEqual([256]);
});

test('it keeps a guest that could give back a step for less than a minute', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { pluggedMib: 1024, requestedMib: 1024, usedMib: 600 });

  const ram = { mib: 1400 };
  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => ram.mib });

  await controller.runTick();

  ctx.advance(59_999);

  await controller.runTick();

  expect(ctx.guests.requests).toStrictEqual([]);
});

test('it shrinks a guest that could give back a step for a minute', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { pluggedMib: 1024, requestedMib: 1024, usedMib: 600 });

  const ram = { mib: 1400 };
  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => ram.mib });

  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();

  // 600 used, so 1008 in all leaves a step past the grow mark; 512 is base
  expect(ctx.guests.requests).toStrictEqual([496]);
});

test('it keeps the limit of a shrunk guest until its RSS falls', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  const guest = ctx.guests.addGuest(imp.paths, {
    pluggedMib: 1024,
    requestedMib: 1024,
    usedMib: 600,
  });

  const ram = { mib: 1400 };
  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => ram.mib });

  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();
  await controller.runTick();

  expect(guest.pluggedMib).toBe(496);
  expect(ctx.limits).toStrictEqual(['dev 1536']);
});

test('it lowers the limit of a shrunk guest once its RSS falls', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { pluggedMib: 1024, requestedMib: 1024, usedMib: 600 });

  const ram = { mib: 1400 };
  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => ram.mib });

  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();
  await controller.runTick();

  ram.mib = 800;

  await controller.runTick();

  expect(ctx.limits).toStrictEqual(['dev 1536', 'dev 1008']);
});

test('it counts what the guest holds once an unplug stops partway', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  ctx.guests.addGuest(imp.paths, {
    pluggedMib: 1024,
    requestedMib: 1024,
    usedMib: 600,
    unplugFloorMib: 768,
  });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 100 });

  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();
  await controller.runTick();

  expect(ctx.plugged.get('dev')).toBe(768);
});

test('it asks an unplug that stops partway back to what the guest holds, and logs it', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  const guest = ctx.guests.addGuest(imp.paths, {
    pluggedMib: 1024,
    requestedMib: 1024,
    usedMib: 600,
    unplugFloorMib: 768,
  });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 100 });

  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();
  await controller.runTick();

  ctx.advance(2000);

  await controller.runTick();

  expect(ctx.guests.requests).toStrictEqual([496, 768]);
  expect(guest.requestedMib).toBe(768);
  expect(ctx.logs.at(-1)).toContain('could not unplug below 1280 MiB');
});

test('it sets the limit to what the guest holds after an unplug stops partway', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  ctx.guests.addGuest(imp.paths, {
    pluggedMib: 1024,
    requestedMib: 1024,
    usedMib: 600,
    unplugFloorMib: 768,
  });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 100 });

  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();
  await controller.runTick();

  ctx.advance(2000);

  await controller.runTick();
  await controller.runTick();

  expect(ctx.limits.at(-1)).toBe('dev 1280');
});

test('it starts no new shrink before the back-off of a stopped unplug ends', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  ctx.guests.addGuest(imp.paths, {
    pluggedMib: 1024,
    requestedMib: 1024,
    usedMib: 600,
    unplugFloorMib: 768,
  });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 100 });

  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();
  await controller.runTick();

  ctx.advance(2000);

  await controller.runTick();
  await controller.runTick();

  ctx.advance(59_000);

  await controller.runTick();
  await controller.runTick();

  expect(ctx.guests.requests).toStrictEqual([496, 768]);
});

test('it leaves a locked imp alone', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { usedMib: 500 });

  const controller = createMemoryController({
    ...ctx.deps,
    readRamMib: () => 400,
    isLocked: () => true,
    tryWhileRunning: () => Promise.resolve(false),
  });

  await controller.runTick();

  expect(ctx.guests.requests).toStrictEqual([]);
  expect(ctx.limits).toStrictEqual([]);
});

test('it sets the limit of an adopted VM to what its guest holds', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { pluggedMib: 512, requestedMib: 512, usedMib: 600 });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();

  expect(ctx.limits).toStrictEqual(['dev 1024']);
  expect(ctx.plugged.get('dev')).toBe(512);
});

test('it forgets what an imp held once the imp no longer runs', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { pluggedMib: 512, requestedMib: 512, usedMib: 600 });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();

  ctx.imps.length = 0;

  await controller.runTick();

  expect(ctx.plugged.has('dev')).toBeFalse();
});

test('it reclaims from idle guests only, and counts what they gave back', async () => {
  const ctx = setupTest();

  const idle = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  const busy = buildMockElasticImp({
    id: 'busy',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  const asker = buildMockElasticImp({
    id: 'asker',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(idle, busy, asker);

  const idleGuest = ctx.guests.addGuest(idle.paths, {
    pluggedMib: 1024,
    requestedMib: 1024,
    usedMib: 600,
  });

  ctx.guests.addGuest(busy.paths, { pluggedMib: 1024, requestedMib: 1024, usedMib: 600 });
  ctx.guests.addGuest(asker.paths, { pluggedMib: 1024, requestedMib: 1024, usedMib: 600 });

  const controller = createMemoryController({
    ...ctx.deps,
    readRamMib: () => 400,
    isBusy: (id) => id === 'busy',
  });

  const freed = await controller.reclaimIdle('asker');

  expect(freed).toBe(1024 - 496);
  expect(idleGuest.pluggedMib).toBe(496);
  expect(ctx.guests.requests).toStrictEqual([496]);
  expect(ctx.plugged.get('dev')).toBe(496);
});

test('it shrinks a large guest to leave 15 % of it free', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 1024,
    maxMemoryMib: 4096,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  ctx.guests.addGuest(imp.paths, {
    baseMib: 1024,
    pluggedMib: 2048,
    requestedMib: 2048,
    usedMib: 2000,
    regionMib: 3072,
  });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();

  // 2656 in all: 656 available, a step past its grow mark of 398
  expect(ctx.guests.requests).toStrictEqual([1632]);
});

test('it never grows a large guest back on the ticks after it shrinks', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 1024,
    maxMemoryMib: 4096,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  const guest = ctx.guests.addGuest(imp.paths, {
    baseMib: 1024,
    pluggedMib: 2048,
    requestedMib: 2048,
    usedMib: 2000,
    regionMib: 3072,
  });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();

  for (let tick = 0; tick < 5; tick += 1) {
    ctx.advance(500);

    await controller.runTick();
  }

  expect(guest.pluggedMib).toBe(1632);
  expect(ctx.grows).toStrictEqual([]);
  expect(ctx.guests.requests).toStrictEqual([1632]);
});

test('it asks a plug that never finishes back, and logs it', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);

  const guest = ctx.guests.addGuest(imp.paths, { usedMib: 500, isSlow: true });
  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();
  await controller.runTick();

  ctx.advance(2000);

  await controller.runTick();

  expect(ctx.guests.requests).toStrictEqual([256, 0]);
  expect(guest.requestedMib).toBe(0);
  expect(ctx.logs.at(-1)).toContain('could not plug past 512 MiB');
});

test('it lowers the limit again after a plug that never finishes', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { usedMib: 500, isSlow: true });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();
  await controller.runTick();

  ctx.advance(2000);

  await controller.runTick();
  await controller.runTick();

  expect(ctx.limits).toStrictEqual(['dev 512', 'dev 768', 'dev 512']);
});

test('it asks for no grow before the back-off of a plug that never finished ends', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { usedMib: 500, isSlow: true });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();
  await controller.runTick();

  ctx.advance(2000);

  await controller.runTick();
  await controller.runTick();

  ctx.advance(59_000);

  await controller.runTick();

  expect(ctx.grows).toHaveLength(1);
});

test('it logs a second plug that never finishes no more', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { usedMib: 500, isSlow: true });

  const controller = createMemoryController({ ...ctx.deps, readRamMib: () => 400 });

  await controller.runTick();
  await controller.runTick();

  ctx.advance(2000);

  await controller.runTick();
  await controller.runTick();

  ctx.advance(60_000);

  await controller.runTick();
  await controller.runTick();

  ctx.advance(2000);

  await controller.runTick();

  expect(ctx.guests.requests).toStrictEqual([256, 0, 256, 0]);
  expect(ctx.logs.filter((line) => line.includes('could not plug'))).toHaveLength(1);
});

test('it plugs nothing for a grow that a sleep overtakes, and gives its reservation back', async () => {
  const ctx = setupTest();

  const imp = buildMockElasticImp({
    id: 'dev',
    memoryMib: 512,
    maxMemoryMib: 1536,
    agentVersion: '0.17.0',
  });

  ctx.imps.push(imp);
  ctx.guests.addGuest(imp.paths, { usedMib: 500 });

  const controller = createMemoryController({
    ...ctx.deps,
    readRamMib: () => 400,
    tryWhileRunning: () => Promise.resolve(false),
  });

  await controller.runTick();

  expect(ctx.grows).toHaveLength(1);
  expect(ctx.releases).toStrictEqual(['dev']);
  expect(ctx.guests.requests).toStrictEqual([]);
  expect(ctx.limits).toStrictEqual(['dev 512']);
});
