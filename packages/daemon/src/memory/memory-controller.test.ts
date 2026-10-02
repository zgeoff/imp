import { expect, test } from 'bun:test';
import { buildImpPaths } from '../storage/data-layout';
import type { ImpPaths } from '../storage/data-layout';
import type { GuestMemory } from '../vmm/vm-runner';
import { createMemoryController } from './memory-controller';
import type { ElasticImp } from './memory-controller';

interface FakeGuest {
  baseMib: number;
  pluggedMib: number;
  requestedMib: number;
  usedMib: number;

  // an unplug stops here, as a guest stops at memory it cannot migrate
  unplugFloorMib: number;

  // true: a request is taken, but the guest has not moved yet
  isSlow: boolean;
}

interface ControllerTestOptions {
  readonly memoryMib?: number;
  readonly maxMemoryMib?: number;
  readonly agentVersion?: string | undefined;
  readonly admits?: boolean;
  readonly busy?: readonly string[];
  readonly locked?: readonly string[];

  // imps a sleep takes between the tick's look and its plug
  readonly asleep?: readonly string[];
}

// One elastic imp `dev` (512 MiB, max 1536 by default) on a fake guest, a
// clock the test moves, and a record of every call the controller made.
function setupControllerTest(options: Readonly<ControllerTestOptions> = {}) {
  const clock = { now: 0 };

  const guests = new Map<string, FakeGuest>();

  const limits: string[] = [];
  const grows: { id: string; mib: number }[] = [];
  const releases: string[] = [];
  const requests: number[] = [];
  const logs: string[] = [];

  const plugged = new Map<string, number>();

  const ram = { mib: 400 };

  const buildImp = (id: string): ElasticImp => ({
    id,
    name: id,
    pid: 1,
    memoryMib: options.memoryMib ?? 512,
    maxMemoryMib: options.maxMemoryMib ?? 1536,
    paths: buildImpPaths('/data', id),
    agentVersion: 'agentVersion' in options ? options.agentVersion : '0.17.0',
  });

  const imps = [buildImp('dev')];

  const setupGuest = (id: string, guest: Partial<FakeGuest> = {}): FakeGuest => {
    const created: FakeGuest = {
      baseMib: 512,
      pluggedMib: 0,
      requestedMib: 0,
      usedMib: 300,
      unplugFloorMib: 0,
      isSlow: false,
      ...guest,
    };

    guests.set(buildImpPaths('/data', id).dir, created);

    return created;
  };

  const readGuest = (paths: ImpPaths): FakeGuest => {
    const guest = guests.get(paths.dir);

    if (guest === undefined) {
      throw new Error('no such VM');
    }

    return guest;
  };

  const controller = createMemoryController({
    listElastic: () => Promise.resolve(imps),
    vms: {
      readGuestMemory: (paths): Promise<GuestMemory> => {
        const guest = readGuest(paths);

        if (!guest.isSlow) {
          guest.pluggedMib = Math.max(
            guest.requestedMib,
            Math.min(guest.pluggedMib, guest.unplugFloorMib),
          );
        }

        const totalMib = guest.baseMib + guest.pluggedMib;

        return Promise.resolve({
          pluggedMib: guest.pluggedMib,
          requestedMib: guest.requestedMib,
          totalMib,
          availableMib: totalMib - guest.usedMib,
        });
      },
      requestPluggedMib: (paths, mib) => {
        readGuest(paths).requestedMib = mib;

        requests.push(mib);

        return Promise.resolve();
      },
    },
    isLocked: (id) => options.locked?.includes(id) ?? false,
    isBusy: (id) => options.busy?.includes(id) ?? false,
    tryWhileRunning: async (id, action) => {
      if (options.locked?.includes(id) === true || options.asleep?.includes(id) === true) {
        return false;
      }

      await action();

      return true;
    },
    admitGrow: (request) => {
      grows.push({ id: request.id, mib: request.mib });

      return Promise.resolve(options.admits ?? true);
    },
    releaseGrow: (id) => {
      releases.push(id);
    },
    limit: {
      setGuestMib: (id, guestMib) => {
        limits.push(`${id} ${String(guestMib)}`);
      },
    },
    readRamMib: () => ram.mib,
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
  });

  return {
    clock,
    imps,
    limits,
    grows,
    releases,
    requests,
    logs,
    plugged,
    ram,
    setupGuest,
    buildImp,
    controller,
    advance: (ms: number) => {
      clock.now += ms;
    },
  };
}

test('a guest low on memory grows a step, its limit raised before the plug', async () => {
  const ctx = setupControllerTest();
  const guest = ctx.setupGuest('dev', { usedMib: 490 });

  await ctx.controller.runTick();

  // 256 MiB and its 4 MiB of struct pages
  expect(ctx.grows).toEqual([{ id: 'dev', mib: 260 }]);
  expect(ctx.limits).toEqual(['dev 512', 'dev 768']);
  expect(ctx.requests).toEqual([256]);

  // the next tick sees the plug done, and enough free
  await ctx.controller.runTick();

  expect(guest.pluggedMib).toBe(256);
  expect(ctx.plugged.get('dev')).toBe(256);
  expect(ctx.grows).toHaveLength(1);
});

test('a guest grows step by step to its max and no further', async () => {
  const ctx = setupControllerTest({ maxMemoryMib: 1000 });
  const guest = ctx.setupGuest('dev', { usedMib: 2000 });

  for (let tick = 0; tick < 5; tick += 1) {
    await ctx.controller.runTick();
  }

  // the region is whole slots (512), but the max (1000) caps it: 256 + 232
  expect(ctx.requests).toEqual([256, 488]);
  expect(guest.pluggedMib).toBe(488);
});

test('a refused grow leaves the guest at its size, logged once', async () => {
  const ctx = setupControllerTest({ admits: false });

  ctx.setupGuest('dev', { usedMib: 500 });

  await ctx.controller.runTick();
  await ctx.controller.runTick();

  expect(ctx.requests).toEqual([]);
  expect(ctx.grows).toHaveLength(2);
  expect(ctx.limits).toEqual(['dev 512']);
  expect(ctx.logs.filter((line) => line.includes('no room to grow'))).toHaveLength(1);
});

test('an agent from before elastic memory gets no grow, logged once, and one with no record neither', async () => {
  for (const agentVersion of ['0.16.0', undefined]) {
    const ctx = setupControllerTest({ agentVersion });

    ctx.setupGuest('dev', { usedMib: 490 });

    await ctx.controller.runTick();
    await ctx.controller.runTick();

    expect(ctx.grows).toEqual([]);
    expect(ctx.requests).toEqual([]);

    const refusals = ctx.logs.filter((line) => line.includes('not grown'));

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('stop and start the imp');
  }
});

test('a plug under way is waited for, never asked twice', async () => {
  const ctx = setupControllerTest();

  ctx.setupGuest('dev', { usedMib: 500, isSlow: true });

  await ctx.controller.runTick();
  await ctx.controller.runTick();

  expect(ctx.requests).toEqual([256]);
});

test('a guest that could give back a step for a minute shrinks', async () => {
  const ctx = setupControllerTest();
  const guest = ctx.setupGuest('dev', { pluggedMib: 1024, requestedMib: 1024, usedMib: 600 });

  ctx.ram.mib = 1400;

  await ctx.controller.runTick();

  ctx.advance(59_000);

  await ctx.controller.runTick();

  expect(ctx.requests).toEqual([]);

  ctx.advance(1000);

  await ctx.controller.runTick();

  // 600 used, so 1008 in all leaves a step past the grow mark; 512 is base
  expect(ctx.requests).toEqual([496]);

  // the guest got there, but the RSS has not fallen yet: the limit stays
  await ctx.controller.runTick();

  expect(guest.pluggedMib).toBe(496);
  expect(ctx.limits).toEqual(['dev 1536']);

  ctx.ram.mib = 800;

  await ctx.controller.runTick();

  expect(ctx.limits).toEqual(['dev 1536', 'dev 1008']);
});

test('an unplug that stops partway keeps what the guest holds, and backs off', async () => {
  const ctx = setupControllerTest();

  const guest = ctx.setupGuest('dev', {
    pluggedMib: 1024,
    requestedMib: 1024,
    usedMib: 600,
    unplugFloorMib: 768,
  });

  ctx.ram.mib = 100;

  await ctx.controller.runTick();

  ctx.advance(60_000);

  await ctx.controller.runTick();

  expect(ctx.requests).toEqual([496]);

  // the guest stops at 768: plugged, not requested, is what counts
  await ctx.controller.runTick();

  expect(ctx.plugged.get('dev')).toBe(768);

  ctx.advance(2000);

  await ctx.controller.runTick();

  expect(ctx.requests).toEqual([496, 768]);
  expect(guest.requestedMib).toBe(768);
  expect(ctx.logs.at(-1)).toContain('could not unplug below 1280 MiB');

  // the limit follows what the guest still holds
  await ctx.controller.runTick();

  expect(ctx.limits.at(-1)).toBe('dev 1280');

  // no new shrink before the back-off ends
  ctx.advance(59_000);

  await ctx.controller.runTick();
  await ctx.controller.runTick();

  expect(ctx.requests).toEqual([496, 768]);
});

test('a locked imp is left alone, and a VM impd adopts gets a limit for what it holds', async () => {
  const locked = setupControllerTest({ locked: ['dev'] });

  locked.setupGuest('dev', { usedMib: 500 });

  await locked.controller.runTick();

  expect(locked.requests).toEqual([]);
  expect(locked.limits).toEqual([]);

  const adopted = setupControllerTest();

  adopted.setupGuest('dev', { pluggedMib: 512, requestedMib: 512, usedMib: 600 });

  await adopted.controller.runTick();

  expect(adopted.limits).toEqual(['dev 1024']);
  expect(adopted.plugged.get('dev')).toBe(512);

  // the imp went to sleep: what the controller knew goes with it
  adopted.imps.length = 0;

  await adopted.controller.runTick();

  expect(adopted.plugged.has('dev')).toBe(false);
});

test('a reclaim unplugs idle guests only, and counts what they gave back', async () => {
  const ctx = setupControllerTest({ busy: ['busy'] });

  ctx.imps.push(ctx.buildImp('busy'), ctx.buildImp('asker'));

  const idle = ctx.setupGuest('dev', { pluggedMib: 1024, requestedMib: 1024, usedMib: 600 });

  ctx.setupGuest('busy', { pluggedMib: 1024, requestedMib: 1024, usedMib: 600 });
  ctx.setupGuest('asker', { pluggedMib: 1024, requestedMib: 1024, usedMib: 600 });

  const freed = await ctx.controller.reclaimIdle('asker');

  expect(freed).toBe(1024 - 496);
  expect(idle.pluggedMib).toBe(496);
  expect(ctx.requests).toEqual([496]);
  expect(ctx.plugged.get('dev')).toBe(496);
});

test('a large guest that shrinks is not grown back by the next tick', async () => {
  // 15 % of a guest past 1.7 GiB is more than a step: the grow mark rises
  const ctx = setupControllerTest({ memoryMib: 1024, maxMemoryMib: 4096 });

  const guest = ctx.setupGuest('dev', {
    baseMib: 1024,
    pluggedMib: 2048,
    requestedMib: 2048,
    usedMib: 2000,
  });

  await ctx.controller.runTick();

  ctx.advance(60_000);

  await ctx.controller.runTick();

  // 2656 in all: 656 available, a step past its grow mark of 398
  expect(ctx.requests).toEqual([1632]);

  for (let tick = 0; tick < 5; tick += 1) {
    ctx.advance(500);

    await ctx.controller.runTick();
  }

  expect(guest.pluggedMib).toBe(1632);
  expect(ctx.grows).toEqual([]);
  expect(ctx.requests).toEqual([1632]);
});

test('a plug that never finishes is asked back, logged once, and backs off', async () => {
  const ctx = setupControllerTest();
  const guest = ctx.setupGuest('dev', { usedMib: 500, isSlow: true });

  await ctx.controller.runTick();
  await ctx.controller.runTick();

  ctx.advance(2000);

  await ctx.controller.runTick();

  // the guest keeps what it reached, and the limit comes back down
  expect(ctx.requests).toEqual([256, 0]);
  expect(guest.requestedMib).toBe(0);
  expect(ctx.logs.at(-1)).toContain('could not plug past 512 MiB');

  await ctx.controller.runTick();

  expect(ctx.limits).toEqual(['dev 512', 'dev 768', 'dev 512']);

  // no grow before the back-off ends; the next stall is not logged again
  ctx.advance(59_000);

  await ctx.controller.runTick();

  expect(ctx.grows).toHaveLength(1);

  ctx.advance(1000);

  await ctx.controller.runTick();
  await ctx.controller.runTick();

  ctx.advance(2000);

  await ctx.controller.runTick();

  expect(ctx.requests).toEqual([256, 0, 256, 0]);
  expect(ctx.logs.filter((line) => line.includes('could not plug'))).toHaveLength(1);
});

test('a grow that a sleep overtakes plugs nothing and gives its reservation back', async () => {
  const ctx = setupControllerTest({ asleep: ['dev'] });

  ctx.setupGuest('dev', { usedMib: 500 });

  await ctx.controller.runTick();

  expect(ctx.grows).toHaveLength(1);
  expect(ctx.releases).toEqual(['dev']);
  expect(ctx.requests).toEqual([]);
  expect(ctx.limits).toEqual(['dev 512']);
});
