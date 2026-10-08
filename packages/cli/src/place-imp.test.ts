import { expect, mock, test } from 'bun:test';
import { buildMockSystemInfo } from '@imp/api/test-utils/build-mock-system-info';
import { ORPCError } from '@orpc/client';
import { buildRanking, createPlaced, readFreeMib } from './place-imp';
import { buildMockHostProbe } from './test-utils/build-mock-host-probe';

test('#buildRanking ranks the host with the most free RAM first, a tie in name order', () => {
  const ram = { ramUsedMib: 0, ramReservedMib: 0, ramSleepingMib: 0 };

  const ranking = buildRanking(
    [
      {
        host: 'a',
        value: buildMockHostProbe({
          info: { ...ram, ramBudgetMib: 8192, ramUsedMib: 4096 },
        }),
      },
      {
        host: 'b',
        value: buildMockHostProbe({
          info: { ...ram, ramBudgetMib: 16_384, ramReservedMib: 1024 },
        }),
      },
      {
        host: 'c',
        value: buildMockHostProbe({ info: { ...ram, ramBudgetMib: 8192 } }),
      },
      {
        host: 'd',
        value: buildMockHostProbe({ info: { ...ram, ramBudgetMib: 8192 } }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking).toStrictEqual({
    ranked: [
      { host: 'b', freeMib: 15_360 },
      { host: 'c', freeMib: 8192 },
      { host: 'd', freeMib: 8192 },
      { host: 'a', freeMib: 4096 },
    ],
    dropped: [],
  });
});

test("#readFreeMib counts every sleeper's memory as taken", () => {
  const info = buildMockSystemInfo({
    ramBudgetMib: 8192,
    ramUsedMib: 1000,
    ramReservedMib: 500,
    ramSleepingMib: 4096,
  });

  expect(readFreeMib(info)).toBe(8192 - 1000 - 500 - 4096);
});

test('#readFreeMib counts no sleepers for an impd from before ramSleepingMib', () => {
  const { ramSleepingMib, ...info } = buildMockSystemInfo({
    ramBudgetMib: 8192,
    ramUsedMib: 1000,
    ramReservedMib: 500,
  });

  expect(readFreeMib(info)).toBe(8192 - 1000 - 500);
});

test('#buildRanking ranks a host below another when its sleepers take more RAM', () => {
  const ranking = buildRanking(
    [
      {
        host: 'sleepy',
        value: buildMockHostProbe({
          info: {
            ramBudgetMib: 8192,
            ramUsedMib: 1000,
            ramReservedMib: 500,
            ramSleepingMib: 4096,
          },
        }),
      },
      {
        host: 'busy',
        value: buildMockHostProbe({
          info: {
            ramBudgetMib: 8192,
            ramUsedMib: 4096,
            ramReservedMib: 0,
            ramSleepingMib: 0,
          },
        }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.ranked).toStrictEqual([
    { host: 'busy', freeMib: 4096 },
    { host: 'sleepy', freeMib: 2596 },
  ]);
});

test('#buildRanking drops a host that did not answer, with its error', () => {
  const ranking = buildRanking(
    [
      { host: 'laptop', error: 'no answer in 5 s' },
      { host: 'box', value: buildMockHostProbe() },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  const received: unknown = ranking;

  expect(received).toStrictEqual({
    ranked: [{ host: 'box', freeMib: expect.any(Number) as unknown }],
    dropped: [{ host: 'laptop', reason: 'no answer in 5 s' }],
  });
});

test('#buildRanking drops a host without the image asked for', () => {
  const ranking = buildRanking(
    [
      { host: 'has', value: buildMockHostProbe({ images: ['myapp'] }) },
      { host: 'lacks', value: buildMockHostProbe({ images: ['base'] }) },
    ],
    {
      name: 'dev',
      image: 'myapp',
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([{ host: 'lacks', reason: 'it has no image myapp' }]);
});

test('#buildRanking drops a host without its own default image when none is asked', () => {
  const ranking = buildRanking(
    [
      {
        host: 'has',
        value: buildMockHostProbe({
          info: { defaults: { image: 'base' } },
          images: ['myapp'],
        }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([{ host: 'has', reason: 'it has no image base' }]);
});

test('#buildRanking drops a host with no default image when none is asked', () => {
  const ranking = buildRanking(
    [
      {
        host: 'none',
        value: buildMockHostProbe({
          info: { defaults: { image: null } },
          images: ['myapp'],
        }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'none', reason: 'it has no default image; name one with --image' },
  ]);
});

test('#buildRanking keeps a small host whose budget fits its default memory', () => {
  const ranking = buildRanking(
    [
      {
        host: 'small',
        value: buildMockHostProbe({
          info: { ramBudgetMib: 1024, defaults: { memoryMib: 512 } },
        }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toBeEmpty();
});

test('#buildRanking drops a host whose budget is below the memory asked', () => {
  const ranking = buildRanking(
    [
      {
        host: 'small',
        value: buildMockHostProbe({
          info: { ramBudgetMib: 1024, defaults: { memoryMib: 512 } },
        }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: 2048,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'small', reason: 'its RAM budget of 1024 MiB is below 2048 MiB' },
  ]);
});

test('#buildRanking drops a host whose budget is below its own default memory', () => {
  const ranking = buildRanking(
    [
      {
        host: 'tight',
        value: buildMockHostProbe({
          info: { ramBudgetMib: 1024, defaults: { memoryMib: 2048 } },
        }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'tight', reason: 'its RAM budget of 1024 MiB is below 2048 MiB' },
  ]);
});

test.each([['open'], [null]] as const)(
  '#buildRanking keeps a host that cannot enforce egress for the %p policy',
  (policyMode) => {
    const ranking = buildRanking(
      [
        {
          host: 'open',
          value: buildMockHostProbe({
            info: { egress: { isEnforced: false } },
          }),
        },
      ],
      {
        name: 'dev',
        image: null,
        memoryMib: null,
        cpuLimit: null,
        policyMode,
        networks: [],
        needsWholeHost: false,
      },
    );

    expect(ranking.dropped).toBeEmpty();
  },
);

test('#buildRanking drops a host that cannot enforce a box policy', () => {
  const ranking = buildRanking(
    [
      {
        host: 'open',
        value: buildMockHostProbe({ info: { egress: { isEnforced: false } } }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: 'box',
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'open', reason: 'it cannot enforce a box egress policy' },
  ]);
});

test('#buildRanking drops a host that predates the public policy', () => {
  const older = buildMockHostProbe({ info: { version: '0.12.0' }, withoutInfo: ['features'] });

  const ranking = buildRanking([{ host: 'older', value: older }], {
    name: 'dev',
    image: null,
    memoryMib: null,
    cpuLimit: null,
    policyMode: 'public',
    networks: [],
    needsWholeHost: false,
  });

  expect(ranking.dropped).toStrictEqual([
    { host: 'older', reason: 'impd 0.12.0 predates the public egress policy' },
  ]);
});

test('#buildRanking drops a host that cannot enforce a public policy', () => {
  const ranking = buildRanking(
    [
      {
        host: 'unenforced',
        value: buildMockHostProbe({ info: { egress: { isEnforced: false } } }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: 'public',
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'unenforced', reason: 'it cannot enforce a public egress policy' },
  ]);
});

test('#buildRanking keeps a current host for a public policy', () => {
  const ranking = buildRanking([{ host: 'current', value: buildMockHostProbe() }], {
    name: 'dev',
    image: null,
    memoryMib: null,
    cpuLimit: null,
    policyMode: 'public',
    networks: [],
    needsWholeHost: false,
  });

  expect(ranking.dropped).toBeEmpty();
});

test('#buildRanking drops a host with low storage', () => {
  const ranking = buildRanking(
    [
      {
        host: 'low',
        value: buildMockHostProbe({ info: { storage: { isLow: true } } }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([{ host: 'low', reason: 'its storage is low' }]);
});

test('#buildRanking drops a host with fewer cores than the CPU limit', () => {
  const ranking = buildRanking(
    [
      {
        host: 'small',
        value: buildMockHostProbe({ info: { cpu: { hostCpus: 4 } } }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: 6,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'small', reason: 'it has 4 cores, fewer than the CPU limit' },
  ]);
});

test('#buildRanking drops a host without each network asked for, naming the missing ones', () => {
  const ranking = buildRanking(
    [
      { host: 'netted', value: buildMockHostProbe({ networks: ['lab'] }) },
      { host: 'bare', value: buildMockHostProbe() },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: ['lab', 'ci'],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'netted', reason: 'it has no network ci' },
    { host: 'bare', reason: 'it has no network lab, ci' },
  ]);
});

test('#buildRanking drops a host whose token has read scope', () => {
  const ranking = buildRanking(
    [
      {
        host: 'read',
        value: buildMockHostProbe({ identity: { scope: 'read' } }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'read', reason: 'its token has read scope, not manage' },
  ]);
});

test("#buildRanking drops a host whose token may not touch the imp's name", () => {
  const ranking = buildRanking(
    [
      {
        host: 'limited',
        value: buildMockHostProbe({ identity: { imps: ['ci-*'] } }),
      },
    ],
    {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'limited', reason: 'its token may not touch dev (ci-*)' },
  ]);
});

test("#buildRanking keeps a host whose token patterns match the imp's name", () => {
  const ranking = buildRanking(
    [
      {
        host: 'limited',
        value: buildMockHostProbe({ identity: { imps: ['ci-*'] } }),
      },
    ],
    {
      name: 'ci-1',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  const ranked: unknown = ranking.ranked;

  expect(ranked).toStrictEqual([{ host: 'limited', freeMib: expect.any(Number) as unknown }]);
});

test('#buildRanking drops a host whose limited token cannot create an unnamed imp', () => {
  const ranking = buildRanking(
    [
      {
        host: 'limited',
        value: buildMockHostProbe({ identity: { imps: ['ci-*'] } }),
      },
    ],
    {
      name: null,
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    { host: 'limited', reason: 'its token is limited to some imps, so the imp needs a name' },
  ]);
});

test('#buildRanking drops a host whose limited token cannot take --public or --net', () => {
  const ranking = buildRanking(
    [
      {
        host: 'limited',
        value: buildMockHostProbe({ identity: { imps: ['ci-*'] } }),
      },
    ],
    {
      name: 'ci-1',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: true,
    },
  );

  expect(ranking.dropped).toStrictEqual([
    {
      host: 'limited',
      reason: 'its token is limited to some imps, which --public and --net need it not to be',
    },
  ]);
});

test('#buildRanking drops an impd from before placement', () => {
  const old = buildMockHostProbe({ info: { version: '0.12.0' }, withoutInfo: ['defaults'] });

  const ranking = buildRanking([{ host: 'old', value: old }], {
    name: 'dev',
    image: null,
    memoryMib: null,
    cpuLimit: null,
    policyMode: null,
    networks: [],
    needsWholeHost: false,
  });

  expect(ranking.dropped).toStrictEqual([
    { host: 'old', reason: 'impd 0.12.0 is too old to place on; upgrade it or use --host' },
  ]);
});

test('#buildRanking rejects a name another host has already', () => {
  const answers = [
    { host: 'a', value: buildMockHostProbe() },
    { host: 'b', value: buildMockHostProbe({ imps: ['dev'] }) },
  ];

  expect(() =>
    buildRanking(answers, {
      name: 'dev',
      image: null,
      memoryMib: null,
      cpuLimit: null,
      policyMode: null,
      networks: [],
      needsWholeHost: false,
    }),
  ).toThrowWithMessage(Error, 'dev exists on b already; pick another name');
});

test('#buildRanking leaves a generated name to impd though a host has an imp of that name', () => {
  const ranking = buildRanking([{ host: 'b', value: buildMockHostProbe({ imps: ['dev'] }) }], {
    name: null,
    image: null,
    memoryMib: null,
    cpuLimit: null,
    policyMode: null,
    networks: [],
    needsWholeHost: false,
  });

  const ranked: unknown = ranking.ranked;

  expect(ranked).toStrictEqual([{ host: 'b', freeMib: expect.any(Number) as unknown }]);
});

test('#createPlaced moves on to the next host after a RAM refusal, with one create per host', async () => {
  const create = mock((host: string) =>
    host === 'a'
      ? Promise.reject(
          new ORPCError('RAM_BUDGET_EXCEEDED', {
            status: 503,
            message: 'Not enough RAM budget, even after sleeping idle imps',
          }),
        )
      : Promise.resolve(`imp on ${host}`),
  );

  const placed = await createPlaced(
    [
      { host: 'a', freeMib: 3 },
      { host: 'b', freeMib: 2 },
      { host: 'c', freeMib: 1 },
    ],
    create,
    () => {},
  );

  expect(placed).toStrictEqual({ host: 'b', value: 'imp on b' });
  expect(create.mock.calls).toStrictEqual([['a'], ['b']]);
});

test('#createPlaced reports each RAM refusal with its host', async () => {
  const onRefusal = mock<(host: string, message: string) => void>();

  await createPlaced(
    [
      { host: 'a', freeMib: 3 },
      { host: 'b', freeMib: 2 },
      { host: 'c', freeMib: 1 },
    ],
    (host) =>
      host === 'a'
        ? Promise.reject(
            new ORPCError('RAM_BUDGET_EXCEEDED', {
              status: 503,
              message: 'Not enough RAM budget, even after sleeping idle imps',
            }),
          )
        : Promise.resolve(`imp on ${host}`),
    onRefusal,
  );

  expect(onRefusal).toHaveBeenCalledExactlyOnceWith(
    'a',
    'Not enough RAM budget, even after sleeping idle imps',
  );
});

test('#createPlaced ends placement on a timeout, with no second create', () => {
  const failure = new Error('no answer in 5 s');

  const create = mock<(host: string) => Promise<string>>(() => Promise.reject(failure));

  const placed = createPlaced(
    [
      { host: 'a', freeMib: 3 },
      { host: 'b', freeMib: 2 },
      { host: 'c', freeMib: 1 },
    ],
    create,
    () => {},
  );

  expect(placed).rejects.toBe(failure);
  expect(create.mock.calls).toStrictEqual([['a']]);
});

test('#createPlaced ends placement on a missing image, with no second create', () => {
  const failure = new ORPCError('NOT_FOUND', { message: 'no image myapp' });

  const create = mock<(host: string) => Promise<string>>(() => Promise.reject(failure));

  const placed = createPlaced(
    [
      { host: 'a', freeMib: 3 },
      { host: 'b', freeMib: 2 },
      { host: 'c', freeMib: 1 },
    ],
    create,
    () => {},
  );

  expect(placed).rejects.toBe(failure);
  expect(create.mock.calls).toStrictEqual([['a']]);
});

test('#createPlaced ends placement on a refusal other than RAM, with no second create', () => {
  const failure = new ORPCError('FORBIDDEN', { message: 'not allowed' });

  const create = mock<(host: string) => Promise<string>>(() => Promise.reject(failure));

  const placed = createPlaced(
    [
      { host: 'a', freeMib: 3 },
      { host: 'b', freeMib: 2 },
      { host: 'c', freeMib: 1 },
    ],
    create,
    () => {},
  );

  expect(placed).rejects.toBe(failure);
  expect(create.mock.calls).toStrictEqual([['a']]);
});

test('#createPlaced rejects when every host refuses for RAM', () => {
  const create = mock<(host: string) => Promise<string>>(() =>
    Promise.reject(
      new ORPCError('RAM_BUDGET_EXCEEDED', {
        status: 503,
        message: 'Not enough RAM budget, even after sleeping idle imps',
      }),
    ),
  );

  const placed = createPlaced(
    [
      { host: 'a', freeMib: 3 },
      { host: 'b', freeMib: 2 },
      { host: 'c', freeMib: 1 },
    ],
    create,
    () => {},
  );

  expect(placed).rejects.toThrowWithMessage(
    Error,
    'every host that could take the imp turned it away for RAM',
  );

  expect(create.mock.calls).toStrictEqual([['a'], ['b'], ['c']]);
});

test('#createPlaced rejects an empty ranking without a create', () => {
  const create = mock<(host: string) => Promise<string>>(() => Promise.resolve('imp'));
  const placed = createPlaced([], create, () => {});

  expect(placed).rejects.toThrowWithMessage(
    Error,
    'every host that could take the imp turned it away for RAM',
  );

  expect(create).not.toHaveBeenCalled();
});
