import { expect, test } from 'bun:test';
import type { ImpEvent } from '@impz/api';
import { waitFor } from '@impz/test-utils/wait-for';
import fc from 'fast-check';
import { createEventBus } from '../events/event-bus';
import { buildStubGovernedHost } from '../test-utils/build-stub-governed-host';
import type { RoomLeft } from '../test-utils/build-stub-governed-host';
import { buildStubGovernedHostArbitraries } from '../test-utils/build-stub-governed-host-arbitraries';
import { ENFORCE_INTERVAL_MS, createRamGovernor } from './ram-governor';

// docs/architecture/lifecycle/ram-governor.md#enforcement says every 5 s, and the scale e2e suite
// allows use over the budget for that long
test('it enforces the budget every 5 s, as the docs say', () => {
  expect(ENFORCE_INTERVAL_MS).toBe(5000);
});

test('it sleeps the least recently active imp that is not busy to make room', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['pinned', 'old', 'new'],
    awake: [
      { id: 'pinned', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  host.applyChange({ kind: 'busy', id: 'pinned', on: true }, governor);

  await governor.admit({ id: 'x', name: 'x', reserveMib: 300, memoryMib: 600 });

  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['old']);
});

test('it publishes the sleep it made room with and the admission', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['pinned', 'old', 'new'],
    awake: [
      { id: 'pinned', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const events = createEventBus();
  const published: ImpEvent[] = [];

  events.subscribe((event) => {
    published.push(event);
  });

  const governor = createRamGovernor({ ...host.deps, events, log: () => {} });

  host.applyChange({ kind: 'busy', id: 'pinned', on: true }, governor);

  await governor.admit({ id: 'x', name: 'x', reserveMib: 300, memoryMib: 600 });

  expect(published).toStrictEqual([
    {
      v: 1,
      at: new Date(1_000_000),
      ev: 'GovernorDecision',
      budgetMib: 1000,
      decision: 'slept',
      name: 'old',
      trigger: 'to make room for x',
      usedMib: 900,
    },
    {
      v: 1,
      at: new Date(1_000_000),
      ev: 'GovernorDecision',
      budgetMib: 1000,
      decision: 'admitted',
      name: 'x',
      trigger: 'admission',
      usedMib: 600,
      reserveMib: 300,
    },
  ]);
});

test('it refuses an admit that sleeping the other idle imps cannot make room for, and sleeps none', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['pinned', 'old', 'new'],
    awake: [
      { id: 'pinned', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const events = createEventBus();
  const published: ImpEvent[] = [];

  events.subscribe((event) => {
    published.push(event);
  });

  const governor = createRamGovernor({ ...host.deps, events, log: () => {} });

  host.applyChange({ kind: 'busy', id: 'pinned', on: true }, governor);

  await governor.admit({ id: 'x', name: 'x', reserveMib: 300, memoryMib: 600 });

  expect(
    governor.admit({ id: 'y', name: 'y', reserveMib: 900, memoryMib: 900 }),
  ).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  // sleeping `new` alone could not make room, so it stays awake
  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['old']);

  // 900 in use and 900 asked: 800 short, with the busy `pinned` in the way
  expect(published.at(-1)).toStrictEqual({
    v: 1,
    at: new Date(1_000_000),
    ev: 'GovernorDecision',
    budgetMib: 1000,
    decision: 'refused',
    name: 'y',
    trigger: 'admission',
    usedMib: 900,
    reserveMib: 900,
    neededMib: 800,
    protectedCount: 1,
  });
});

test('it never admits an imp whose memory is larger than the whole budget', () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['idle', 'huge'],
    awake: [{ id: 'idle', rssMib: 300 }],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  expect(
    governor.admit({ id: 'huge', name: 'huge', reserveMib: 100, memoryMib: 1001 }),
  ).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { budgetMib: 1000, usedMib: 300, requestedMib: 1001 },
  });

  expect(host.sleepCalls).toStrictEqual([]);
});

test('it picks the next victim when the one it picked is skipped', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['old', 'mid', 'new'],
    awake: [
      { id: 'old', rssMib: 300 },
      { id: 'mid', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  host.refuseSleep('old', 'skipped');

  await governor.admit({ id: 'x', name: 'x', reserveMib: 300, memoryMib: 300 });

  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['old', 'mid']);
});

test('it refuses an admit once only victims that are skipped are left', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['old', 'mid', 'new'],
    awake: [
      { id: 'old', rssMib: 300 },
      { id: 'mid', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  host.refuseSleep('old', 'skipped');

  await governor.admit({ id: 'x', name: 'x', reserveMib: 300, memoryMib: 300 });

  // 300 awake in `old` and 300 reserved for x: 700 more needs `old` again
  expect(
    governor.admit({ id: 'y', name: 'y', reserveMib: 700, memoryMib: 700 }),
  ).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
});

test('it sleeps no more imps for a rejected admit once a victim is skipped', () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['old', 'mid', 'new'],
    awake: [
      { id: 'old', rssMib: 300 },
      { id: 'mid', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  host.refuseSleep('mid', 'skipped');

  // 800 missing picks all three; once `mid` is skipped, `new` alone cannot
  // free the 500 still missing, so it stays awake
  expect(
    governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 }),
  ).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['old', 'mid']);
});

test('it refuses an admit with the disk error when a victim had no room for its snapshot', () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['old', 'new'],
    awake: [
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({
    ...host.deps,
    readDiskFullError: () => new Error('the disk has no room for a snapshot'),
    log: () => {},
  });

  host.refuseSleep('old', 'diskFull');

  // 500 missing: with `old` kept awake, `new` alone cannot free it
  expect(
    governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 }),
  ).rejects.toThrowWithMessage(Error, 'the disk has no room for a snapshot');
});

test('it counts a reservation until its 20 s run out, and not a moment longer', async () => {
  const host = buildStubGovernedHost({ budgetMib: 1000, ids: ['x'], awake: [] });
  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  await governor.admit({ id: 'x', name: 'x', reserveMib: 400, memoryMib: 800 });

  host.applyChange({ kind: 'tick', ms: 20_000 }, governor);

  const atDeadline = await governor.readUsage();

  host.applyChange({ kind: 'tick', ms: 1 }, governor);

  const after = await governor.readUsage();

  expect(atDeadline.reservedMib).toBe(400);
  expect(after.reservedMib).toBe(0);
});

test('it sleeps every idle imp, oldest first, when together they cannot reach the budget', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['big', 'old', 'mid', 'new'],
    awake: [
      { id: 'big', rssMib: 2000 },
      { id: 'old', rssMib: 100 },
      { id: 'mid', rssMib: 100 },
      { id: 'new', rssMib: 100 },
    ],
  });

  const logs: string[] = [];

  const governor = createRamGovernor({
    ...host.deps,
    log: (message) => {
      logs.push(message);
    },
  });

  host.applyChange({ kind: 'hold', id: 'big', on: true }, governor);

  await governor.enforce();

  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['old', 'mid', 'new']);

  expect(['big', 'old', 'mid', 'new'].filter((id) => host.findImp(id).awake)).toStrictEqual([
    'big',
  ]);

  expect(logs).toStrictEqual(['impd: governor: slept 3, RAM still over budget by 1000 MiB']);
});

test('it asks no imp and stays quiet on the passes after nothing is left to sleep', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['big', 'old', 'mid', 'new'],
    awake: [
      { id: 'big', rssMib: 2000 },
      { id: 'old', rssMib: 100 },
      { id: 'mid', rssMib: 100 },
      { id: 'new', rssMib: 100 },
    ],
  });

  const logs: string[] = [];

  const governor = createRamGovernor({
    ...host.deps,
    log: (message) => {
      logs.push(message);
    },
  });

  host.applyChange({ kind: 'hold', id: 'big', on: true }, governor);

  await governor.enforce();
  await governor.enforce();
  await governor.enforce();
  await governor.enforce();

  expect(host.sleepCalls).toHaveLength(3);
  expect(logs).toHaveLength(1);
});

test('it still sleeps the other idle imps when one is skipped', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['big', 'old', 'mid', 'new'],
    awake: [
      { id: 'big', rssMib: 2000 },
      { id: 'old', rssMib: 100 },
      { id: 'mid', rssMib: 100 },
      { id: 'new', rssMib: 100 },
    ],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  host.applyChange({ kind: 'hold', id: 'big', on: true }, governor);
  host.refuseSleep('mid', 'skipped');

  await governor.enforce();

  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['old', 'mid', 'new']);

  expect(['big', 'old', 'mid', 'new'].filter((id) => host.findImp(id).awake)).toStrictEqual([
    'big',
    'mid',
  ]);
});

test('it sleeps no imp for an admit when the idle imps together cannot make room', () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['big', 'old', 'mid', 'new'],
    awake: [
      { id: 'big', rssMib: 2000 },
      { id: 'old', rssMib: 100 },
      { id: 'mid', rssMib: 100 },
      { id: 'new', rssMib: 100 },
    ],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  host.applyChange({ kind: 'hold', id: 'big', on: true }, governor);

  expect(
    governor.admit({ id: 'x', name: 'x', reserveMib: 100, memoryMib: 100 }),
  ).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  expect(host.sleepCalls).toStrictEqual([]);
});

test('it says once that nothing is left to sleep, until usage is under the budget again', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['big'],
    awake: [{ id: 'big', rssMib: 2000 }],
  });

  const logs: string[] = [];

  const governor = createRamGovernor({
    ...host.deps,
    log: (message) => {
      logs.push(message);
    },
  });

  host.applyChange({ kind: 'hold', id: 'big', on: true }, governor);

  await governor.enforce();
  await governor.enforce();

  host.applyChange({ kind: 'rss', id: 'big', mib: 500 }, governor);

  await governor.enforce();

  host.applyChange({ kind: 'rss', id: 'big', mib: 1500 }, governor);

  await governor.enforce();

  expect(logs).toStrictEqual([
    'impd: governor: RAM over budget by 1000 MiB and no idle imp left to sleep',
    'impd: governor: RAM over budget by 500 MiB and no idle imp left to sleep',
  ]);
});

test('it admits an admission that may not sleep imps into free room, and publishes nothing without a name', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['idle', 't1'],
    awake: [{ id: 'idle', rssMib: 600 }],
  });

  const events = createEventBus();
  const published: ImpEvent[] = [];

  events.subscribe((event) => {
    published.push(event);
  });

  const governor = createRamGovernor({ ...host.deps, events, log: () => {} });

  await governor.admit({
    id: 't1',
    name: null,
    reserveMib: 300,
    memoryMib: 600,
    maySleepImps: false,
  });

  const usage = await governor.readUsage();

  expect(usage.reservedMib).toBe(300);
  expect(published).toStrictEqual([]);
});

test('it refuses an admission that may not sleep imps once the free room is gone, and sleeps none', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['idle', 't1', 't2'],
    awake: [{ id: 'idle', rssMib: 600 }],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  await governor.admit({
    id: 't1',
    name: null,
    reserveMib: 300,
    memoryMib: 600,
    maySleepImps: false,
  });

  expect(
    governor.admit({ id: 't2', name: null, reserveMib: 300, memoryMib: 600, maySleepImps: false }),
  ).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  expect(host.sleepCalls).toStrictEqual([]);
});

test('it reports no headroom while KSM saves nothing', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a', 'b'],
    awake: [
      { id: 'a', rssMib: 300 },
      { id: 'b', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({
    ...host.deps,
    readHeadroomMib: () => Promise.resolve(0),
    log: () => {},
  });

  const usage = await governor.readUsage();

  expect(usage).toStrictEqual({ usedMib: 600, reservedMib: 0, headroomMib: 0 });
});

test('it measures every awake imp at once, each read started before any ends', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a', 'b', 'c'],
    awake: [
      { id: 'a', rssMib: 100 },
      { id: 'b', rssMib: 200 },
      { id: 'c', rssMib: 300 },
    ],
  });

  const pending = new Map<string, PromiseWithResolvers<number | null>>();

  // each read waits for the test; the usage resolves only once all three ran
  const governor = createRamGovernor({
    ...host.deps,
    readRamMib: (_pid, id) => {
      const read = Promise.withResolvers<number | null>();

      pending.set(id, read);

      return read.promise;
    },
    log: () => {},
  });

  const usage = governor.readUsage();

  await waitFor(() => {
    expect([...pending.keys()]).toStrictEqual(['a', 'b', 'c']);
  });

  for (const [id, read] of pending) {
    const ramMib = await host.deps.readRamMib(0, id);

    read.resolve(ramMib);
  }

  const measured = await usage;

  expect(measured).toStrictEqual({ usedMib: 600, reservedMib: 0, headroomMib: 0 });
});

test('it reports the KSM headroom in the usage', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a', 'b'],
    awake: [
      { id: 'a', rssMib: 300 },
      { id: 'b', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({
    ...host.deps,
    readHeadroomMib: () => Promise.resolve(300),
    log: () => {},
  });

  const usage = await governor.readUsage();

  expect(usage).toStrictEqual({ usedMib: 600, reservedMib: 0, headroomMib: 300 });
});

test('it counts the KSM headroom against the budget, so a merged page that splits still fits', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a', 'b', 'c'],
    awake: [
      { id: 'a', rssMib: 300 },
      { id: 'b', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({
    ...host.deps,
    readHeadroomMib: () => Promise.resolve(300),
    log: () => {},
  });

  // 600 used and 300 headroom leave 100: a 200 MiB wake sleeps the oldest
  await governor.admit({ id: 'c', name: 'c', reserveMib: 200, memoryMib: 512 });

  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['a']);
});

test('it sleeps the least recently active idle imp for a grow, never the grower', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['grower', 'old', 'new'],
    awake: [
      { id: 'grower', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  const admitted = await governor.admitGrow({ id: 'grower', name: 'grower', mib: 260 });

  expect(admitted).toBeTrue();
  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['old']);
});

test('it asks the idle guests other than the grower to give back memory before a grow sleeps one', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['grower', 'old', 'new'],
    awake: [
      { id: 'grower', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const reclaims: (string | null)[] = [];

  const governor = createRamGovernor({
    ...host.deps,
    reclaim: (excludeId) => {
      reclaims.push(excludeId);

      return host.deps.reclaim(excludeId);
    },
    log: () => {},
  });

  await governor.admitGrow({ id: 'grower', name: 'grower', mib: 260 });

  expect(reclaims).toStrictEqual(['grower']);
});

test('it counts a grow as reserved until the grower measures it', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['grower', 'old', 'new'],
    awake: [
      { id: 'grower', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  await governor.admitGrow({ id: 'grower', name: 'grower', mib: 260 });

  const usage = await governor.readUsage();

  expect(usage).toStrictEqual({ usedMib: 600, reservedMib: 260, headroomMib: 0 });
});

test('it sleeps no imp when an unplug the reclaim did not count made room', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['old', 'x'],
    awake: [{ id: 'old', rssMib: 700 }],
  });

  // the guest's earlier unplug ends while the reclaim runs, which counts none of it
  const governor = createRamGovernor({
    ...host.deps,
    log: () => {},
    reclaim: () => {
      host.applyChange({ kind: 'rss', id: 'old', mib: 300 }, governor);

      return Promise.resolve(0);
    },
  });

  await governor.admit({ id: 'x', name: 'x', reserveMib: 500, memoryMib: 600 });

  expect(host.sleepCalls).toStrictEqual([]);
});

test('it puts back the wake reservation that a released grow counted in', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 2000,
    ids: ['grower'],
    awake: [{ id: 'grower', rssMib: 300 }],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  await governor.admit({ id: 'grower', name: 'grower', reserveMib: 500, memoryMib: 600 });
  await governor.admitGrow({ id: 'grower', name: 'grower', mib: 260 });

  governor.releaseGrow('grower');

  const usage = await governor.readUsage();

  expect(usage).toStrictEqual({ usedMib: 300, reservedMib: 200, headroomMib: 0 });
});

test('it reserves nothing once a grow with no reservation before it is released', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 2000,
    ids: ['grower'],
    awake: [{ id: 'grower', rssMib: 300 }],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  await governor.admitGrow({ id: 'grower', name: 'grower', mib: 260 });

  governor.releaseGrow('grower');

  const usage = await governor.readUsage();

  expect(usage).toStrictEqual({ usedMib: 300, reservedMib: 0, headroomMib: 0 });
});

test('it keeps a wake reservation made after a grow when the grow is released', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 2000,
    ids: ['grower'],
    awake: [{ id: 'grower', rssMib: 300 }],
  });

  const governor = createRamGovernor({ ...host.deps, log: () => {} });

  await governor.admitGrow({ id: 'grower', name: 'grower', mib: 260 });
  await governor.admit({ id: 'grower', name: 'grower', reserveMib: 500, memoryMib: 600 });

  governor.releaseGrow('grower');

  const usage = await governor.readUsage();

  expect(usage).toStrictEqual({ usedMib: 300, reservedMib: 200, headroomMib: 0 });
});

test('it refuses a grow when only busy imps could make room, and publishes why', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['grower', 'old', 'new'],
    awake: [
      { id: 'grower', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const events = createEventBus();
  const published: ImpEvent[] = [];

  events.subscribe((event) => {
    published.push(event);
  });

  const governor = createRamGovernor({ ...host.deps, events, log: () => {} });

  host.applyChange({ kind: 'busy', id: 'old', on: true }, governor);
  host.applyChange({ kind: 'busy', id: 'new', on: true }, governor);

  const admitted = await governor.admitGrow({ id: 'grower', name: 'grower', mib: 260 });

  expect(admitted).toBeFalse();
  expect(host.sleepCalls).toStrictEqual([]);

  // the two busy imps were in the way; the grower itself is not counted
  expect(published).toStrictEqual([
    {
      v: 1,
      at: new Date(1_000_000),
      ev: 'GovernorDecision',
      budgetMib: 1000,
      decision: 'refused',
      name: 'grower',
      trigger: 'grow',
      usedMib: 900,
      reserveMib: 260,
      neededMib: 160,
      protectedCount: 2,
    },
  ]);
});

test('it makes no room and reserves nothing for a grow of an imp that is no longer awake', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['grower', 'old', 'new'],
    awake: [
      { id: 'grower', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const reclaims: (string | null)[] = [];

  const governor = createRamGovernor({
    ...host.deps,
    reclaim: (excludeId) => {
      reclaims.push(excludeId);

      return host.deps.reclaim(excludeId);
    },
    log: () => {},
  });

  host.applyChange({ kind: 'stop', id: 'grower' }, governor);

  const admitted = await governor.admitGrow({ id: 'grower', name: 'grower', mib: 260 });
  const usage = await governor.readUsage();

  expect(admitted).toBeFalse();
  expect(reclaims).toStrictEqual([]);
  expect(host.sleepCalls).toStrictEqual([]);
  expect(usage).toStrictEqual({ usedMib: 600, reservedMib: 0, headroomMib: 0 });
});

// with IMP_KSM a split of every merged page must still fit after the grow
test('it counts the KSM headroom for a grow, as for a boot or a wake', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['old', 'grower'],
    awake: [
      { id: 'old', rssMib: 300 },
      { id: 'grower', rssMib: 300 },
    ],
  });

  const governor = createRamGovernor({
    ...host.deps,

    // KSM saves 300 MiB while both run, nothing in one alone
    readHeadroomMib: (pids) => {
      const headroomMib = pids.length > 1 ? 300 : 0;

      return Promise.resolve(headroomMib);
    },
    log: () => {},
  });

  // 600 used and 300 headroom leave 100: a 200 MiB grow sleeps the other imp
  const admitted = await governor.admitGrow({ id: 'grower', name: 'grower', mib: 200 });

  expect(admitted).toBeTrue();
  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['old']);
});

test('it lets idle guests unplug instead of sleeping an imp for a boot', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['grower', 'old', 'new', 'x'],
    awake: [
      { id: 'grower', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const reclaims: (string | null)[] = [];

  const governor = createRamGovernor({
    ...host.deps,
    reclaim: (excludeId) => {
      reclaims.push(excludeId);

      return host.deps.reclaim(excludeId);
    },
    log: () => {},
  });

  host.applyChange({ kind: 'spare', id: 'new', mib: 200 }, governor);

  await governor.admit({ id: 'x', name: 'x', reserveMib: 250, memoryMib: 512 });

  expect(reclaims).toStrictEqual(['x']);
  expect(host.sleepCalls).toStrictEqual([]);
});

test('it lets idle guests unplug before enforcement sleeps an imp', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['grower', 'old', 'new', 'x'],
    awake: [
      { id: 'grower', rssMib: 300 },
      { id: 'old', rssMib: 300 },
      { id: 'new', rssMib: 300 },
    ],
  });

  const reclaims: (string | null)[] = [];

  const governor = createRamGovernor({
    ...host.deps,
    reclaim: (excludeId) => {
      reclaims.push(excludeId);

      return host.deps.reclaim(excludeId);
    },
    log: () => {},
  });

  host.applyChange({ kind: 'spare', id: 'new', mib: 200 }, governor);

  await governor.admit({ id: 'x', name: 'x', reserveMib: 250, memoryMib: 512 });

  host.applyChange({ kind: 'rss', id: 'old', mib: 900 }, governor);

  await governor.enforce();

  // the reclaim gave back nothing more, so the least recently active sleeps
  expect(reclaims).toStrictEqual(['x', null]);
  expect(host.sleepCalls.map((call) => call.id)).toStrictEqual(['grower']);
});

// The property tests: each case builds its own host and governor, which hold no
// resource to release. A failure reports fast-check's seed, path and shrunk
// counterexample.

test('it keeps each admission within the budget and never asks a pinned imp to sleep, one op at a time', async () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c', 'd', 'e', 'f']);

  const opArb = fc.oneof(
    arbitraries.admit,
    arbitraries.change,
    fc.constant({ kind: 'enforce' as const }),
  );

  await fc.assert(
    fc.asyncProperty(arbitraries.awake, fc.array(opArb, { maxLength: 40 }), async (awake, ops) => {
      const host = buildStubGovernedHost({
        budgetMib: 1000,
        ids: ['a', 'b', 'c', 'd', 'e', 'f'],
        awake,
      });

      const governor = createRamGovernor({ ...host.deps, log: () => {} });

      for (const op of ops) {
        const awakeBefore = [...host.imps.values()].filter((imp) => imp.awake).length;
        const callsBefore = host.sleepCalls.length;
        let rejected = false;

        if (op.kind === 'admit') {
          if (host.findImp(op.id).awake) {
            continue;
          }

          // an admit that cannot fit throws RAM_BUDGET_EXCEEDED; anything
          // else fails the property
          const outcome = await governor
            .admit({
              id: op.id,
              name: op.id,
              reserveMib: op.reserveMib,
              memoryMib: op.reserveMib + op.extraMib,
            })
            .then(() => 'admitted' as const)
            .catch((error: unknown) => {
              expect(error).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

              return 'rejected' as const;
            });

          if (outcome === 'admitted') {
            host.markAdmitted(op.id);

            const usage = await governor.readUsage();

            expect(usage.usedMib + usage.reservedMib).toBeLessThanOrEqual(1000);
          } else {
            rejected = true;

            const reservedMib = await host.readReservation(op.id, governor);

            expect(reservedMib).toBe(0);
          }
        } else if (op.kind === 'enforce') {
          await governor.enforce();

          // under the budget, or every imp it may sleep is asleep
          expect(host.findRoomLeft()).toSatisfy(
            (room: RoomLeft) => room.overMib <= 0 || room.eligibleAwake === 0,
          );
        } else {
          host.applyChange(op, governor);
        }

        const calls = host.sleepCalls.slice(callsBefore);

        // nothing changes between the pick and the sleep: no pinned imp is
        // even asked, and each awake imp at most once
        expect(calls.filter((call) => !call.eligible)).toStrictEqual([]);
        expect(calls.length).toBeLessThanOrEqual(awakeBefore);

        // a rejected admit gives up at a failed sleep, never after a sleep
        // that worked, which would leave the pick enough; with no call at
        // all, nothing slept
        if (rejected) {
          expect(calls.slice(-1).map((call) => call.outcome)).not.toContain('slept');
        }
      }
    }),
    { numRuns: 1000 },
  );
}, 30_000);

test('it gets a crowded host under the budget or sleeps every imp it may', async () => {
  // imps up to the whole budget each, often held or busy: often the imps
  // enforce may sleep cannot free enough between them
  const crowdedArb = fc.uniqueArray(
    fc.record({
      id: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
      rssMib: fc.integer({ min: 0, max: 1000 }),
      held: fc.boolean(),
      busy: fc.boolean(),
    }),
    { selector: (imp) => imp.id, minLength: 1, maxLength: 6 },
  );

  await fc.assert(
    fc.asyncProperty(crowdedArb, async (crowded) => {
      const host = buildStubGovernedHost({
        budgetMib: 1000,
        ids: ['a', 'b', 'c', 'd', 'e', 'f'],
        awake: crowded,
      });

      const governor = createRamGovernor({ ...host.deps, log: () => {} });

      for (const imp of crowded) {
        host.applyChange({ kind: 'hold', id: imp.id, on: imp.held }, governor);
        host.applyChange({ kind: 'busy', id: imp.id, on: imp.busy }, governor);
      }

      await governor.enforce();

      expect(host.sleepCalls.filter((call) => !call.eligible)).toStrictEqual([]);

      expect(host.findRoomLeft()).toSatisfy(
        (room: RoomLeft) => room.overMib <= 0 || room.eligibleAwake === 0,
      );
    }),
    { numRuns: 300 },
  );
}, 30_000);

test('it settles concurrent admits with holds and RSS changes inside them, leaving no reservation for a rejected one', async () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c', 'd', 'e', 'f']);

  // up to four admits for different imps, started at once
  const admitsArb = fc.uniqueArray(arbitraries.admit, {
    selector: (admit) => admit.id,
    maxLength: 4,
  });

  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      arbitraries.awake,
      admitsArb,
      fc.array(arbitraries.change, { maxLength: 20 }),
      async (scheduler, awake, admits, changes) => {
        const host = buildStubGovernedHost({
          budgetMib: 1000,
          ids: ['a', 'b', 'c', 'd', 'e', 'f'],
          awake,
        });

        const governor = createRamGovernor({ ...host.deps, log: () => {} });

        host.pacer.pace = () => scheduler.schedule(Promise.resolve());

        const pending = admits.filter((admit) => !host.findImp(admit.id).awake);

        const admitting = pending.map((admit) =>
          governor
            .admit({
              id: admit.id,
              name: admit.id,
              reserveMib: admit.reserveMib,
              memoryMib: admit.reserveMib + admit.extraMib,
            })
            .then(() => {
              host.markAdmitted(admit.id);

              return { id: admit.id, outcome: 'admitted' as const };
            })
            .catch((error: unknown) => {
              expect(error).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

              return { id: admit.id, outcome: 'rejected' as const };
            }),
        );

        const enforcing = governor.enforce();

        // each change lands wherever the scheduler releases it, inside an
        // admit as often as between two
        const changing = changes.map(async (change) => {
          await scheduler.schedule(Promise.resolve());

          host.applyChange(change, governor);
        });

        const outcomes = await scheduler.waitFor(Promise.all(admitting));

        await scheduler.waitFor(Promise.all([enforcing, ...changing]));

        // a pin set after the pick reaches the stand-in, which refuses it as
        // the real sleep does under the lock; the governor moves on. Each
        // admit and the enforce pass ask each imp at most once.
        expect(host.sleepCalls.length).toBeLessThanOrEqual((admitting.length + 1) * 6);

        host.pacer.pace = () => Promise.resolve();

        for (const admitted of outcomes) {
          if (admitted.outcome === 'rejected') {
            const reservedMib = await host.readReservation(admitted.id, governor);

            expect(reservedMib).toBe(0);
          }
        }

        await governor.enforce();

        // under the budget, or every imp it may sleep is asleep
        expect(host.findRoomLeft()).toSatisfy(
          (room: RoomLeft) => room.overMib <= 0 || room.eligibleAwake === 0,
        );
      },
    ),
    { numRuns: 200 },
  );
}, 30_000);

test('it keeps a grow within the budget, never sleeps its grower, and sleeps only for room it then has', async () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c', 'd', 'e', 'f']);

  const opArb = fc.oneof(
    fc.record({
      kind: fc.constant('grow' as const),
      id: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
      mib: fc.integer({ min: 2, max: 600 }),
    }),
    arbitraries.change,
    fc.constant({ kind: 'enforce' as const }),
  );

  await fc.assert(
    fc.asyncProperty(arbitraries.awake, fc.array(opArb, { maxLength: 40 }), async (awake, ops) => {
      const host = buildStubGovernedHost({
        budgetMib: 1000,
        ids: ['a', 'b', 'c', 'd', 'e', 'f'],
        awake,
      });

      const governor = createRamGovernor({ ...host.deps, log: () => {} });

      for (const op of ops) {
        if (op.kind === 'enforce') {
          await governor.enforce();

          continue;
        }

        if (op.kind !== 'grow') {
          host.applyChange(op, governor);
          continue;
        }

        if (!host.findImp(op.id).awake) {
          continue;
        }

        const callsBefore = host.sleepCalls.length;

        const admitted = await governor.admitGrow({ id: op.id, name: op.id, mib: op.mib });

        const calls = host.sleepCalls.slice(callsBefore);

        expect(calls.map((call) => call.id)).not.toContain(op.id);
        expect(calls.filter((call) => !call.eligible)).toStrictEqual([]);

        if (admitted) {
          const usage = await governor.readUsage();

          expect(usage.usedMib + usage.reservedMib).toBeLessThanOrEqual(1000);

          // the guest's RSS shows the grow once the plug lands
          host.findImp(op.id).rssMib += op.mib;
        } else {
          // refused: nothing slept for room that was not there, so the last
          // call, if any, did not sleep
          expect(calls.slice(-1).map((call) => call.outcome)).not.toContain('slept');
        }
      }
    }),
    { numRuns: 500 },
  );
}, 30_000);
