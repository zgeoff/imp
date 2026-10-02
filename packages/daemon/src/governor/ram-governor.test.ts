import { expect, test } from 'bun:test';
import { createKeyedMutex } from '../imps/keyed-mutex';
import { createLockFreeSleep } from '../imps/lock-free-sleep';
import type { SleepOutcome } from '../imps/lock-free-sleep';
import { createRamGovernor } from './ram-governor';

// a fake sleep behind a real try-lock, as the governor's type demands
function buildFakeSleep(sleep: (id: string) => Promise<SleepOutcome>) {
  const mutex = createKeyedMutex();

  return createLockFreeSleep<string>(
    (id, action) => mutex.tryRunExclusive(id, () => action(id)),
    (id) => sleep(id),
  );
}

test('it sleeps the oldest unpinned imp and never a pinned one', async () => {
  const awake = new Map([
    ['old', { pid: 1, lastActiveAt: 100 }],
    ['pinned', { pid: 2, lastActiveAt: 50 }],
    ['new', { pid: 3, lastActiveAt: 300 }],
  ]);

  const slept: string[] = [];

  const governor = createRamGovernor({
    budgetMib: 1000,
    listAwake: () =>
      Promise.resolve(
        [...awake].map(([id, imp]) => ({
          id,
          name: id,
          pid: imp.pid,
          apiSocket: '',
          lastActiveAt: imp.lastActiveAt,
          holdUntil: null,
        })),
      ),
    readRamMib: () => 300,
    isBusy: (id) => id === 'pinned',
    trySleepImp: buildFakeSleep((id) => {
      slept.push(id);
      awake.delete(id);

      return Promise.resolve('slept');
    }),
    log: () => {
      // quiet
    },
  });

  await governor.admit({ id: 'x', name: 'x', reserveMib: 300, memoryMib: 600 });

  expect(slept).toEqual(['old']);

  const rejection = await governor
    .admit({ id: 'y', name: 'y', reserveMib: 900, memoryMib: 900 })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  // sleeping `new` alone could not make room, so it stays awake
  expect(slept).toEqual(['old']);
});

test('it never admits an imp whose memory is larger than the whole budget', async () => {
  const slept: string[] = [];

  const governor = createRamGovernor({
    budgetMib: 1000,
    listAwake: () =>
      Promise.resolve([
        { id: 'idle', name: 'idle', pid: 1, apiSocket: '', lastActiveAt: 0, holdUntil: null },
      ]),
    readRamMib: () => 300,
    isBusy: () => false,
    trySleepImp: buildFakeSleep((id) => {
      slept.push(id);

      return Promise.resolve('slept');
    }),
    log: () => {
      // quiet
    },
  });

  const rejection = await governor
    .admit({ id: 'huge', name: 'huge', reserveMib: 100, memoryMib: 1001 })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { budgetMib: 1000, usedMib: 300, requestedMib: 1001 },
  });

  expect(slept).toEqual([]);
});

test('it picks again without a victim that was skipped, and fails once none is left', async () => {
  const awake = new Map([
    ['old', { pid: 1, lastActiveAt: 100 }],
    ['mid', { pid: 2, lastActiveAt: 200 }],
    ['new', { pid: 3, lastActiveAt: 300 }],
  ]);

  // `old` turns out locked when its turn comes; `mid` sleeps
  const tried: string[] = [];

  const governor = createRamGovernor({
    budgetMib: 1000,
    listAwake: () =>
      Promise.resolve(
        [...awake].map(([id, imp]) => ({
          id,
          name: id,
          pid: imp.pid,
          apiSocket: '',
          lastActiveAt: imp.lastActiveAt,
          holdUntil: null,
        })),
      ),
    readRamMib: () => 300,
    isBusy: () => false,
    trySleepImp: buildFakeSleep((id) => {
      tried.push(id);

      if (id === 'old') {
        return Promise.resolve('skipped');
      }

      awake.delete(id);

      return Promise.resolve('slept');
    }),
    log: () => {
      // quiet
    },
  });

  await governor.admit({ id: 'x', name: 'x', reserveMib: 300, memoryMib: 300 });

  expect(tried).toEqual(['old', 'mid']);

  // 300 awake in `old` + 300 reserved for x: 700 more needs `old` again,
  // which is skipped every time
  const rejection = await governor
    .admit({ id: 'y', name: 'y', reserveMib: 700, memoryMib: 700 })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
});

test('a reservation counts until its 20 s run out, and not a moment longer', async () => {
  const clock = { now: 1000 };

  const governor = createRamGovernor({
    budgetMib: 1000,
    listAwake: () => Promise.resolve([]),
    readRamMib: () => null,
    isBusy: () => false,
    trySleepImp: buildFakeSleep(() => Promise.resolve('skipped')),
    log: () => {
      // quiet
    },
    now: () => clock.now,
  });

  await governor.admit({ id: 'x', name: 'x', reserveMib: 400, memoryMib: 800 });

  clock.now += 20_000;

  const atDeadline = await governor.readUsage();

  clock.now += 1;

  const after = await governor.readUsage();

  expect([atDeadline.reservedMib, after.reservedMib]).toEqual([400, 0]);
});
