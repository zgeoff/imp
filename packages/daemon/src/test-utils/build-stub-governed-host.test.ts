import { expect, test } from 'bun:test';
import { buildStubGovernedHost } from './build-stub-governed-host';

test('it lists the awake imps, least recently active first by their start order', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a', 'b', 'c'],
    awake: [
      { id: 'b', rssMib: 100 },
      { id: 'a', rssMib: 200 },
    ],
  });

  const awake = await host.deps.listAwake();

  expect(awake).toStrictEqual([
    { id: 'a', name: 'a', pid: 1, apiSocket: 'a', lastActiveAt: 1, holdUntil: null },
    { id: 'b', name: 'b', pid: 2, apiSocket: 'b', lastActiveAt: 0, holdUntil: null },
  ]);
});

test('it lists a held imp with a hold that never expires', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a'],
    awake: [{ id: 'a', rssMib: 100 }],
  });

  host.applyChange({ kind: 'hold', id: 'a', on: true }, { release: () => {} });

  const awake = await host.deps.listAwake();

  expect(awake[0]?.holdUntil).toBe(Number.MAX_SAFE_INTEGER);
});

test('it measures an awake imp', () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a', 'b'],
    awake: [{ id: 'a', rssMib: 100 }],
  });

  expect(host.deps.readRamMib(1, 'a')).toBe(100);
});

test('it measures nothing for an asleep imp', () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a', 'b'],
    awake: [{ id: 'a', rssMib: 100 }],
  });

  expect(host.deps.readRamMib(2, 'b')).toBeNull();
});

test('it sleeps an awake imp the governor asks for', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a'],
    awake: [{ id: 'a', rssMib: 100 }],
  });

  const outcome = await host.deps.trySleepImp('a', 'test', { by: 'governor' });

  expect(outcome).toBe('slept');
  expect(host.findImp('a').awake).toBeFalse();
  expect(host.sleepCalls).toStrictEqual([{ id: 'a', eligible: true, outcome: 'slept' }]);
});

test.each(['hold', 'busy'] as const)(
  'it refuses to sleep an imp with a %s and records the call',
  async (kind) => {
    const host = buildStubGovernedHost({
      budgetMib: 1000,
      ids: ['a'],
      awake: [{ id: 'a', rssMib: 100 }],
    });

    host.applyChange({ kind, id: 'a', on: true }, { release: () => {} });

    const outcome = await host.deps.trySleepImp('a', 'test', { by: 'governor' });

    expect(outcome).toBe('skipped');
    expect(host.sleepCalls).toStrictEqual([{ id: 'a', eligible: false, outcome: 'skipped' }]);
  },
);

test('it fails the sleep of an imp whose snapshot fails and keeps it awake', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a'],
    awake: [{ id: 'a', rssMib: 100, failsSleep: true }],
  });

  const outcome = await host.deps.trySleepImp('a', 'test', { by: 'governor' });

  expect(outcome).toBe('failed');
  expect(host.findImp('a').awake).toBeTrue();
});

test.each(['skipped', 'failed', 'diskFull'] as const)(
  'it turns out a sleep it was told to refuse as %s and keeps the imp awake',
  async (outcome) => {
    const host = buildStubGovernedHost({
      budgetMib: 1000,
      ids: ['a'],
      awake: [{ id: 'a', rssMib: 100 }],
    });

    host.refuseSleep('a', outcome);

    const slept = await host.deps.trySleepImp('a', 'test', { by: 'governor' });

    expect(slept).toBe(outcome);
    expect(host.findImp('a').awake).toBeTrue();
  },
);

test('it counts no imp whose sleep it refuses among those the governor may still sleep', () => {
  const host = buildStubGovernedHost({
    budgetMib: 100,
    ids: ['a'],
    awake: [{ id: 'a', rssMib: 300 }],
  });

  host.refuseSleep('a', 'skipped');

  expect(host.findRoomLeft()).toStrictEqual({ overMib: 200, eligibleAwake: 0 });
});

test('it reclaims what idle awake guests can spare, except the one asking', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a', 'b', 'c'],
    awake: [
      { id: 'a', rssMib: 300 },
      { id: 'b', rssMib: 300 },
      { id: 'c', rssMib: 300 },
    ],
  });

  host.applyChange({ kind: 'spare', id: 'a', mib: 100 }, { release: () => {} });
  host.applyChange({ kind: 'spare', id: 'b', mib: 50 }, { release: () => {} });
  host.applyChange({ kind: 'spare', id: 'c', mib: 70 }, { release: () => {} });
  host.applyChange({ kind: 'busy', id: 'b', on: true }, { release: () => {} });

  const freed = await host.deps.reclaim('c');

  expect(freed).toBe(100);
  expect(host.findImp('a').rssMib).toBe(200);
});

test('it tells the governor of an imp that stops', () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a'],
    awake: [{ id: 'a', rssMib: 100 }],
  });

  const released: string[] = [];

  host.applyChange(
    { kind: 'stop', id: 'a' },
    {
      release: (id) => {
        released.push(id);
      },
    },
  );

  expect(released).toStrictEqual(['a']);
  expect(host.findImp('a').awake).toBeFalse();
});

test('it moves the clock on a tick', () => {
  const host = buildStubGovernedHost({ budgetMib: 1000, ids: ['a'], awake: [] });

  host.applyChange({ kind: 'tick', ms: 500 }, { release: () => {} });

  expect(host.deps.now()).toBe(1_000_500);
});

test('it marks an admitted imp awake, measuring nothing, active now', () => {
  const host = buildStubGovernedHost({ budgetMib: 1000, ids: ['a'], awake: [] });

  host.markAdmitted('a');

  expect(host.findImp('a')).toStrictEqual({
    awake: true,
    rssMib: 0,
    lastActiveAt: 1_000_000,
    held: false,
    busy: false,
    failsSleep: false,
    spareMib: 0,
  });
});

test('it finds how far awake imps are over the budget and how many may still sleep', () => {
  const host = buildStubGovernedHost({
    budgetMib: 500,
    ids: ['a', 'b', 'c'],
    awake: [
      { id: 'a', rssMib: 300 },
      { id: 'b', rssMib: 300, failsSleep: true },
      { id: 'c', rssMib: 100 },
    ],
  });

  host.applyChange({ kind: 'hold', id: 'c', on: true }, { release: () => {} });

  expect(host.findRoomLeft()).toStrictEqual({ overMib: 200, eligibleAwake: 1 });
});

test('it reads what an asleep imp holds reserved from the governor usage', async () => {
  const host = buildStubGovernedHost({ budgetMib: 1000, ids: ['a'], awake: [] });

  const usage = [
    { usedMib: 0, reservedMib: 300, headroomMib: 0 },
    { usedMib: 1_000_000, reservedMib: 0, headroomMib: 0 },
  ];

  const reserved = await host.readReservation('a', {
    readUsage: () =>
      Promise.resolve(usage.shift() ?? { usedMib: 0, reservedMib: 0, headroomMib: 0 }),
  });

  expect(reserved).toBe(300);

  expect(host.findImp('a')).toStrictEqual({
    awake: false,
    rssMib: 0,
    lastActiveAt: 0,
    held: false,
    busy: false,
    failsSleep: false,
    spareMib: 0,
  });
});

test('it reads no reservation for an awake imp', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a'],
    awake: [{ id: 'a', rssMib: 100 }],
  });

  const reserved = await host.readReservation('a', {
    readUsage: () => Promise.resolve({ usedMib: 0, reservedMib: 300, headroomMib: 0 }),
  });

  expect(reserved).toBe(0);
});

test('it throws for an imp it does not hold', () => {
  const host = buildStubGovernedHost({ budgetMib: 1000, ids: ['a'], awake: [] });

  expect(() => host.findImp('z')).toThrowWithMessage(Error, 'no imp z');
});

test('it paces each read and sleep through the pacer', async () => {
  const host = buildStubGovernedHost({
    budgetMib: 1000,
    ids: ['a'],
    awake: [{ id: 'a', rssMib: 100 }],
  });

  const paced: string[] = [];

  host.pacer.pace = () => {
    paced.push('pace');

    return Promise.resolve();
  };

  await host.deps.listAwake();
  await host.deps.reclaim(null);
  await host.deps.trySleepImp('a', 'test', { by: 'governor' });

  expect(paced).toHaveLength(3);
});
