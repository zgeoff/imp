import { expect, test } from 'bun:test';
import { createRamGovernor } from './ram-governor';

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
    sleepImp: (id) => {
      slept.push(id);
      awake.delete(id);

      return Promise.resolve(true);
    },
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
    sleepImp: (id) => {
      slept.push(id);

      return Promise.resolve(true);
    },
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
