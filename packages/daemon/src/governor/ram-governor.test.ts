import { expect, test } from 'bun:test';
import type { ImpEvent } from '@imp/api';
import { createEventBus } from '../events/event-bus';
import { buildStubGovernedHost } from '../test-utils/build-stub-governed-host';
import { ENFORCE_INTERVAL_MS, createRamGovernor } from './ram-governor';

// docs/architecture/sleep-and-wake.md says every 5 s, and the scale e2e suite
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
