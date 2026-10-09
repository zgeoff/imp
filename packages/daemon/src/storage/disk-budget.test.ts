import { expect, mock, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { createDiskBudget } from './disk-budget';

test('it allows a write that leaves the reserve free', async () => {
  // 100 GiB: the default reserve is 5 GiB
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 92 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }),
    },
    reserveBytes: null,
    log: mock<(message: string) => void>(),
  });

  await expect(budget.requireRoom(3 * 1024 ** 3)).toResolve();
});

test('it refuses a write that would leave less than the reserve', () => {
  // 100 GiB: the default reserve is 5 GiB
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 92 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }),
    },
    reserveBytes: null,
    log: mock<(message: string) => void>(),
  });

  expect(budget.requireRoom(4 * 1024 ** 3)).rejects.toMatchObject({
    code: 'DISK_FULL',
    status: 507,
    message:
      'not enough free disk: 8.0 GiB free, 4.0 GiB wanted, and 5.0 GiB is held in reserve (IMP_DISK_RESERVE_GIB)',
    data: {
      availableBytes: 8 * 1024 ** 3,
      reserveBytes: 5 * 1024 ** 3,
      requestedBytes: 4 * 1024 ** 3,
    },
  });
});

test('it reserves 5 GiB of a filesystem of 100 GiB or less', async () => {
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 40 * 1024 ** 3, availableBytes: 60 * 1024 ** 3 }),
    },
    reserveBytes: null,
    log: mock<(message: string) => void>(),
  });

  const status = await budget.readStatus();

  expect(status.reserveBytes).toBe(5 * 1024 ** 3);
});

test('it reserves 5 % of a filesystem larger than 100 GiB', async () => {
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 100 * 1024 ** 3, availableBytes: 300 * 1024 ** 3 }),
    },
    reserveBytes: null,
    log: mock<(message: string) => void>(),
  });

  const status = await budget.readStatus();

  expect(status.reserveBytes).toBe(20 * 1024 ** 3);
});

test('it refuses a write while another write under way holds the room', async () => {
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    log: mock<(message: string) => void>(),
  });

  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  // a sleep writes 4 GiB of memory; free space shows none of it yet
  const sleeping = budget.withRoom(4 * 1024 ** 3, () => {
    started.resolve();

    return release.promise;
  });

  onTestFinished(() => {
    release.resolve();
  });

  await started.promise;

  expect(budget.requireRoom(4 * 1024 ** 3)).rejects.toMatchObject({ code: 'DISK_FULL' });

  release.resolve();

  await sleeping;
});

test('it reports the room a write under way holds as pending', async () => {
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    log: mock<(message: string) => void>(),
  });

  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const sleeping = budget.withRoom(4 * 1024 ** 3, () => {
    started.resolve();

    return release.promise;
  });

  onTestFinished(() => {
    release.resolve();
  });

  await started.promise;

  const status = await budget.readStatus();

  release.resolve();

  await sleeping;

  expect(status).toStrictEqual({
    usedBytes: 90 * 1024 ** 3,
    availableBytes: 10 * 1024 ** 3,
    pendingBytes: 4 * 1024 ** 3,
    reserveBytes: 4 * 1024 ** 3,
    isLow: true,
  });
});

test('it frees the room a write held once the write ends', async () => {
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    log: mock<(message: string) => void>(),
  });

  await budget.withRoom(4 * 1024 ** 3, () => Promise.resolve());

  const status = await budget.readStatus();

  expect(status.pendingBytes).toBe(0);
});

test('it holds the largest total a growing write has asked for', async () => {
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    log: mock<(message: string) => void>(),
  });

  const seen: number[] = [];

  await budget.withGrowingRoom(async (grow) => {
    await grow(1024 ** 3);
    await grow(1024 ** 3 / 2);

    const grown = await budget.readStatus();

    seen.push(grown.pendingBytes);

    await grow(5 * 1024 ** 3);

    const regrown = await budget.readStatus();

    seen.push(regrown.pendingBytes);
  });

  const after = await budget.readStatus();

  expect(seen).toStrictEqual([1024 ** 3, 5 * 1024 ** 3]);
  expect(after.pendingBytes).toBe(0);
});

test('it refuses a growing write that grows past the reserve and frees what it held', async () => {
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    log: mock<(message: string) => void>(),
  });

  const growing = budget.withGrowingRoom(async (grow) => {
    await grow(5 * 1024 ** 3);
    await grow(7 * 1024 ** 3);
  });

  expect(growing).rejects.toMatchObject({
    code: 'DISK_FULL',
    data: {
      availableBytes: 5 * 1024 ** 3,
      reserveBytes: 4 * 1024 ** 3,
      requestedBytes: 2 * 1024 ** 3,
    },
  });

  const status = await budget.readStatus();

  expect(status.pendingBytes).toBe(0);
});

test('it frees all a growing write held when its task throws', async () => {
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    log: mock<(message: string) => void>(),
  });

  const growing = budget.withGrowingRoom(async (grow) => {
    await grow(4 * 1024 ** 3);

    throw new Error('the export hit its limit');
  });

  expect(growing).rejects.toThrowWithMessage(Error, 'the export hit its limit');

  const status = await budget.readStatus();

  expect(status.pendingBytes).toBe(0);
});

test('it counts one growing write against another and frees only the refused one', async () => {
  // 6 GiB above the reserve
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    log: mock<(message: string) => void>(),
  });

  const firstGrown = Promise.withResolvers<void>();
  const firstEnds = Promise.withResolvers<void>();

  const first = budget.withGrowingRoom(async (grow) => {
    await grow(4 * 1024 ** 3);

    firstGrown.resolve();

    await firstEnds.promise;
  });

  onTestFinished(() => {
    firstEnds.resolve();
  });

  await firstGrown.promise;

  const second = budget.withGrowingRoom(async (grow) => {
    await grow(2 * 1024 ** 3);
    await grow(3 * 1024 ** 3);
  });

  expect(second).rejects.toMatchObject({
    code: 'DISK_FULL',
    data: { availableBytes: 4 * 1024 ** 3, requestedBytes: 1024 ** 3 },
  });

  const during = await budget.readStatus();

  firstEnds.resolve();

  await first;

  const after = await budget.readStatus();

  expect(during.pendingBytes).toBe(4 * 1024 ** 3);
  expect(after.pendingBytes).toBe(0);
});

test('it refuses a write with an estimate of 0 once the reserve is reached', () => {
  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 97 * 1024 ** 3, availableBytes: 3 * 1024 ** 3 }),
    },
    reserveBytes: null,
    log: mock<(message: string) => void>(),
  });

  expect(budget.requireRoom(0)).rejects.toMatchObject({
    code: 'DISK_FULL',
    data: { availableBytes: 3 * 1024 ** 3, reserveBytes: 5 * 1024 ** 3, requestedBytes: 0 },
  });
});

test('it keeps a hold for the release delay after its write ends', async () => {
  const startTimer = mock<(fire: () => void, ms: number) => () => void>(() => () => {});

  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    releaseDelayMs: 20_000,
    startTimer,
    log: mock<(message: string) => void>(),
  });

  await budget.withRoom(2 * 1024 ** 3, () => Promise.resolve());

  const status = await budget.readStatus();

  expect(status.pendingBytes).toBe(2 * 1024 ** 3);
  expect(startTimer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 20_000);
});

test('it frees a hold once its release delay is up', async () => {
  const startTimer = mock<(fire: () => void, ms: number) => () => void>(() => () => {});

  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    releaseDelayMs: 20_000,
    startTimer,
    log: mock<(message: string) => void>(),
  });

  await budget.withRoom(2 * 1024 ** 3, () => Promise.resolve());

  const fire = startTimer.mock.calls[0]?.[0];

  invariant(fire);
  fire();

  const status = await budget.readStatus();

  expect(status.pendingBytes).toBe(0);
});

test('it starts no release timer for a zero-byte hold', async () => {
  const startTimer = mock<(fire: () => void, ms: number) => () => void>(() => () => {});

  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 90 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 4 * 1024 ** 3,
    releaseDelayMs: 20_000,
    startTimer,
    log: mock<(message: string) => void>(),
  });

  await budget.requireRoom(0);

  expect(startTimer).not.toHaveBeenCalled();
});

test('it warns once when free space falls below twice the reserve', async () => {
  const log = mock<(message: string) => void>();

  const budget = createDiskBudget({
    storage: {
      readUsage: () =>
        Promise.resolve({ usedBytes: 97 * 1024 ** 3, availableBytes: 3 * 1024 ** 3 }),
    },
    reserveBytes: null,
    log,
  });

  await budget.readStatus();
  await budget.readStatus();

  expect(log).toHaveBeenCalledExactlyOnceWith(
    'impd: warning: low on disk: 3 GiB free, the reserve is 5 GiB',
  );
});

test('it logs low disk once per episode, not on each refusal', async () => {
  const usage = { usedBytes: 94 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 };
  const log = mock<(message: string) => void>();

  const budget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve(usage) },
    reserveBytes: 4 * 1024 ** 3,
    log,
  });

  const refusals = await Promise.allSettled([
    budget.requireRoom(4 * 1024 ** 3),
    budget.requireRoom(4 * 1024 ** 3),
  ]);

  usage.availableBytes = 20 * 1024 ** 3;

  await budget.readStatus();
  await budget.readStatus();

  expect(refusals).toMatchObject([
    { status: 'rejected', reason: { code: 'DISK_FULL' } },
    { status: 'rejected', reason: { code: 'DISK_FULL' } },
  ]);

  expect(log.mock.calls).toStrictEqual([
    ['impd: warning: low on disk: 6 GiB free, the reserve is 4 GiB'],
    ['impd: disk space is back above twice the reserve'],
  ]);
});

test('it logs nothing more while free space hovers at twice the reserve', async () => {
  const usage = { usedBytes: 93 * 1024 ** 3, availableBytes: 7 * 1024 ** 3 };
  const log = mock<(message: string) => void>();

  const budget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve(usage) },
    reserveBytes: 4 * 1024 ** 3,
    log,
  });

  await budget.readStatus();

  usage.availableBytes = 8.5 * 1024 ** 3;

  await budget.readStatus();

  usage.availableBytes = 7.5 * 1024 ** 3;

  await budget.readStatus();

  expect(log).toHaveBeenCalledOnce();
});
