import { expect, test } from 'bun:test';
import { createEventBus } from '../events/event-bus';
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
  const events = createEventBus();
  const decisions: string[] = [];

  events.subscribe((event) => {
    if (event.ev === 'GovernorDecision') {
      decisions.push(`${event.decision} ${event.name} ${event.trigger} ${String(event.usedMib)}`);
    }
  });

  const governor = createRamGovernor({
    budgetMib: 1000,
    events,
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

  expect(decisions).toEqual([
    'slept old to make room for x 900',
    'admitted x admission 600',
    'refused y admission 900',
  ]);
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

test('a rejected admit sleeps no more imps once a victim is skipped', async () => {
  const awake = new Map([
    ['old', { pid: 1, lastActiveAt: 100 }],
    ['mid', { pid: 2, lastActiveAt: 200 }],
    ['new', { pid: 3, lastActiveAt: 300 }],
  ]);

  // `mid` turns out locked when its turn comes
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

      if (id === 'mid') {
        return Promise.resolve('skipped');
      }

      awake.delete(id);

      return Promise.resolve('slept');
    }),
    log: () => {
      // quiet
    },
  });

  // 800 missing picks all three; once `mid` is skipped, `new` alone cannot
  // free the 500 still missing, so it stays awake
  const rejection = await governor
    .admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(tried).toEqual(['old', 'mid']);
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

// Over a 1000 MiB budget by 1300: `big` is held, and the three idle imps
// free only 300 between them.
function setupShortOfBudget(outcomes: Readonly<Record<string, SleepOutcome>> = {}) {
  const awake = new Map([
    ['big', { ramMib: 2000, lastActiveAt: 50, holdUntil: Number.MAX_SAFE_INTEGER }],
    ['new', { ramMib: 100, lastActiveAt: 300, holdUntil: null }],
    ['old', { ramMib: 100, lastActiveAt: 100, holdUntil: null }],
    ['mid', { ramMib: 100, lastActiveAt: 200, holdUntil: null }],
  ]);

  const tried: string[] = [];
  const logs: string[] = [];

  const governor = createRamGovernor({
    budgetMib: 1000,
    listAwake: () =>
      Promise.resolve(
        [...awake].map(([id, imp], index) => ({
          id,
          name: id,
          pid: index + 1,
          apiSocket: id,
          lastActiveAt: imp.lastActiveAt,
          holdUntil: imp.holdUntil,
        })),
      ),

    // apiSocket carries the id
    readRamMib: (_pid, id) => awake.get(id)?.ramMib ?? null,
    isBusy: () => false,
    trySleepImp: buildFakeSleep((id) => {
      tried.push(id);

      const outcome = outcomes[id] ?? 'slept';

      if (outcome === 'slept') {
        awake.delete(id);
      }

      return Promise.resolve(outcome);
    }),
    log: (message) => {
      logs.push(message);
    },
  });

  return { awake, tried, logs, governor };
}

test('enforce sleeps every idle imp, oldest first, when together they cannot reach the budget', async () => {
  const host = setupShortOfBudget();

  await host.governor.enforce();

  expect(host.tried).toEqual(['old', 'mid', 'new']);
  expect([...host.awake.keys()]).toEqual(['big']);
  expect(host.logs).toEqual(['impd: governor: slept 3, RAM still over budget by 1000 MiB']);

  // nothing is left to sleep: the passes after it ask no imp and stay quiet
  await host.governor.enforce();
  await host.governor.enforce();
  await host.governor.enforce();

  expect(host.tried).toEqual(['old', 'mid', 'new']);
  expect(host.logs).toHaveLength(1);
});

test('enforce still sleeps the other idle imps when one is skipped, then stops', async () => {
  const host = setupShortOfBudget({ mid: 'skipped' });

  await host.governor.enforce();

  expect(host.tried).toEqual(['old', 'mid', 'new']);
  expect([...host.awake.keys()]).toEqual(['big', 'mid']);
});

test('admit sleeps no imp when the idle imps together cannot make room', async () => {
  const host = setupShortOfBudget();

  const rejection = await host.governor
    .admit({ id: 'x', name: 'x', reserveMib: 100, memoryMib: 100 })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(host.tried).toEqual([]);
});

test('enforce says once that nothing is left to sleep, until usage is under the budget again', async () => {
  const host = setupShortOfBudget();

  for (const id of ['old', 'mid', 'new']) {
    host.awake.delete(id);
  }

  await host.governor.enforce();
  await host.governor.enforce();

  const big = host.awake.get('big');

  if (big === undefined) {
    throw new Error('no imp big');
  }

  big.ramMib = 500;

  await host.governor.enforce();

  big.ramMib = 1500;

  await host.governor.enforce();

  expect(host.logs).toEqual([
    'impd: governor: RAM over budget by 1000 MiB and no idle imp left to sleep',
    'impd: governor: RAM over budget by 500 MiB and no idle imp left to sleep',
  ]);
});

test('an admission that may not sleep imps takes free room only', async () => {
  const slept: string[] = [];

  const governor = createRamGovernor({
    budgetMib: 1000,
    listAwake: () =>
      Promise.resolve([
        { id: 'idle', name: 'idle', pid: 1, apiSocket: '', lastActiveAt: 0, holdUntil: null },
      ]),
    readRamMib: () => 600,
    isBusy: () => false,
    trySleepImp: buildFakeSleep((id) => {
      slept.push(id);

      return Promise.resolve('slept');
    }),
    log: () => {
      // quiet
    },
  });

  await governor.admit({
    id: 't1',
    name: 't',
    reserveMib: 300,
    memoryMib: 600,
    maySleepImps: false,
  });

  const rejection = await governor
    .admit({ id: 't2', name: 't', reserveMib: 300, memoryMib: 600, maySleepImps: false })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(slept).toEqual([]);
});
