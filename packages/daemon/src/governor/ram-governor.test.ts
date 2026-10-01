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

  await governor.admit({ id: 'x', name: 'x', reserveMib: 300 });

  expect(slept).toEqual(['old']);

  const rejection = await governor
    .admit({ id: 'y', name: 'y', reserveMib: 900 })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  // sleeping `new` alone could not make room, so it stays awake
  expect(slept).toEqual(['old']);
});
