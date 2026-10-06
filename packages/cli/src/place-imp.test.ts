import { expect, test } from 'bun:test';
import type { Identity, SystemInfo } from '@imp/api';
import { ORPCError } from '@orpc/client';
import type { HostAnswer } from './fan-out';
import { buildRanking, createPlaced, readFreeMib } from './place-imp';
import type { HostProbe, PlaceRequest } from './place-imp';

const REQUEST: PlaceRequest = {
  name: 'dev',
  image: null,
  memoryMib: null,
  cpuLimit: null,
  policyMode: null,
  networks: [],
  needsWholeHost: false,
};

const MANAGE: Identity = {
  kind: 'token',
  name: 'root',
  scope: 'manage',
  imps: null,
  grantable: [],
};

function buildInfo(change: Partial<SystemInfo> = {}): SystemInfo {
  return {
    version: '0.12.0',
    ramBudgetMib: 8192,
    ramUsedMib: 0,
    ramReservedMib: 0,
    ramCommittedMib: 0,
    ramSleepingMib: 0,
    awakeCount: 0,
    impCount: 0,
    sessionCount: 0,
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0 } },
    firecrackerVersion: null,
    guestKernel: { version: null, sha256: 'k' },
    systemDrive: { sha256: 's' },
    storage: {
      backend: 'xfs',
      usedBytes: 0,
      availableBytes: 1,
      reserveBytes: 0,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 0,
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
    cpu: { hostCpus: 4, limitsEnforced: true },
    defaults: { memoryMib: 2048, image: 'base' },
    egress: { isEnforced: true },
    ...change,
  };
}

function buildAnswer(host: string, change: Partial<HostProbe> = {}): HostAnswer<HostProbe> {
  return {
    host,
    value: {
      info: buildInfo(),
      identity: MANAGE,
      images: ['base', 'ubuntu'],
      imps: [],
      networks: [],
      ...change,
    },
  };
}

function buildTestRanking(
  answers: readonly HostAnswer<HostProbe>[],
  change: Partial<PlaceRequest> = {},
) {
  return buildRanking(answers, { ...REQUEST, ...change });
}

test('the host with the most free RAM comes first, a tie in name order', () => {
  const ranking = buildTestRanking([
    buildAnswer('a', { info: buildInfo({ ramUsedMib: 4096 }) }),
    buildAnswer('b', { info: buildInfo({ ramBudgetMib: 16_384, ramReservedMib: 1024 }) }),
    buildAnswer('c'),
    buildAnswer('d'),
  ]);

  expect(ranking).toEqual({
    ranked: [
      { host: 'b', freeMib: 15_360 },
      { host: 'c', freeMib: 8192 },
      { host: 'd', freeMib: 8192 },
      { host: 'a', freeMib: 4096 },
    ],
    dropped: [],
  });
});

test("free RAM counts every sleeper's memory as taken", () => {
  const info = buildInfo({ ramUsedMib: 1000, ramReservedMib: 500, ramSleepingMib: 4096 });

  expect(readFreeMib(info)).toBe(8192 - 1000 - 500 - 4096);

  // an impd from before ramSleepingMib counts none
  expect(readFreeMib({ ...info, ramSleepingMib: undefined })).toBe(8192 - 1500);

  const ranking = buildTestRanking([
    buildAnswer('sleepy', { info }),
    buildAnswer('busy', {
      info: buildInfo({ ramUsedMib: 4096 }),
    }),
  ]);

  expect(ranking.ranked.map((host) => host.host)).toEqual(['busy', 'sleepy']);
});

test('a host that did not answer is dropped with its error', () => {
  const ranking = buildTestRanking([
    { host: 'laptop', error: 'no answer in 5 s' },
    buildAnswer('box'),
  ]);

  expect(ranking.dropped).toEqual([{ host: 'laptop', reason: 'no answer in 5 s' }]);
  expect(ranking.ranked.map((host) => host.host)).toEqual(['box']);
});

test('a host without the image, or without a default image, is dropped', () => {
  const answers = [
    buildAnswer('has', { images: ['myapp'] }),
    buildAnswer('lacks'),
    buildAnswer('none', { info: buildInfo({ defaults: { memoryMib: 2048, image: null } }) }),
  ];

  expect(buildTestRanking(answers, { image: 'myapp' }).dropped).toEqual([
    { host: 'lacks', reason: 'it has no image myapp' },
    { host: 'none', reason: 'it has no image myapp' },
  ]);

  // no --image: each host's own default, which must exist there
  expect(buildTestRanking(answers).dropped).toEqual([
    { host: 'has', reason: 'it has no image base' },
    { host: 'none', reason: 'it has no default image; name one with --image' },
  ]);
});

test('a host whose budget is below the memory is dropped, with its default when none is asked', () => {
  const small = buildAnswer('small', {
    info: buildInfo({ ramBudgetMib: 1024, defaults: { memoryMib: 512, image: 'base' } }),
  });

  const big = buildAnswer('big');

  expect(buildTestRanking([small, big]).dropped).toEqual([]);

  expect(buildTestRanking([small, big], { memoryMib: 2048 }).dropped).toEqual([
    { host: 'small', reason: 'its RAM budget of 1024 MiB is below 2048 MiB' },
  ]);

  const tight = buildAnswer('tight', { info: buildInfo({ ramBudgetMib: 1024 }) });

  expect(buildTestRanking([tight]).dropped).toEqual([
    { host: 'tight', reason: 'its RAM budget of 1024 MiB is below 2048 MiB' },
  ]);
});

test('a host that cannot enforce a box or none policy is dropped for one', () => {
  const open = buildAnswer('open', { info: buildInfo({ egress: { isEnforced: false } }) });

  expect(buildTestRanking([open], { policyMode: 'open' }).dropped).toEqual([]);
  expect(buildTestRanking([open]).dropped).toEqual([]);

  expect(buildTestRanking([open], { policyMode: 'box' }).dropped).toEqual([
    { host: 'open', reason: 'it cannot enforce a box egress policy' },
  ]);
});

test('a host that predates the public policy, or cannot enforce it, is dropped for one', () => {
  const current = buildInfo({
    features: { sessionOffsets: true, leases: true, publicEgress: true },
  });

  const hosts = [
    buildAnswer('older'),
    buildAnswer('unenforced', { info: { ...current, egress: { isEnforced: false } } }),
    buildAnswer('current', { info: current }),
  ];

  const ranking = buildTestRanking(hosts, { policyMode: 'public' });

  expect(ranking.dropped).toEqual([
    { host: 'older', reason: 'impd 0.12.0 predates the public egress policy' },
    { host: 'unenforced', reason: 'it cannot enforce a public egress policy' },
  ]);

  expect(ranking.ranked.map((host) => host.host)).toEqual(['current']);
});

test('a host with low storage, too few cores or a missing network is dropped', () => {
  const low = buildAnswer('low', {
    info: buildInfo({ storage: { ...buildInfo().storage, isLow: true } }),
  });

  const netted = buildAnswer('netted', { networks: ['lab'] });

  expect(buildTestRanking([low, netted], { cpuLimit: 6, networks: ['lab'] }).dropped).toEqual([
    { host: 'low', reason: 'its storage is low' },
    { host: 'netted', reason: 'it has 4 cores, fewer than the CPU limit' },
  ]);

  expect(
    buildTestRanking([netted, buildAnswer('bare')], { networks: ['lab', 'ci'] }).dropped,
  ).toEqual([
    { host: 'netted', reason: 'it has no network ci' },
    { host: 'bare', reason: 'it has no network lab, ci' },
  ]);
});

test('a host whose token cannot create the imp is dropped', () => {
  const read = buildAnswer('read', { identity: { ...MANAGE, scope: 'read' } });
  const limited = buildAnswer('limited', { identity: { ...MANAGE, imps: ['ci-*'] } });

  expect(buildTestRanking([read, limited]).dropped).toEqual([
    { host: 'read', reason: 'its token has read scope, not manage' },
    { host: 'limited', reason: 'its token may not touch dev (ci-*)' },
  ]);

  expect(buildTestRanking([limited], { name: 'ci-1' }).ranked).toHaveLength(1);

  expect(buildTestRanking([limited], { name: null }).dropped).toEqual([
    { host: 'limited', reason: 'its token is limited to some imps, so the imp needs a name' },
  ]);

  expect(buildTestRanking([limited], { name: 'ci-1', needsWholeHost: true }).dropped).toEqual([
    {
      host: 'limited',
      reason: 'its token is limited to some imps, which --public and --net need it not to be',
    },
  ]);
});

test('an impd from before placement is dropped', () => {
  const old = buildAnswer('old', { info: buildInfo({ defaults: undefined }) });

  expect(buildTestRanking([old]).dropped).toEqual([
    { host: 'old', reason: 'impd 0.12.0 is too old to place on; upgrade it or use --host' },
  ]);
});

test('a name another host has already ends placement', () => {
  expect(() => buildTestRanking([buildAnswer('a'), buildAnswer('b', { imps: ['dev'] })])).toThrow(
    'dev exists on b already; pick another name',
  );

  // a generated name is impd's to pick
  expect(
    buildTestRanking([buildAnswer('b', { imps: ['dev'] })], { name: null }).ranked,
  ).toHaveLength(1);
});

function buildRamError() {
  return new ORPCError('RAM_BUDGET_EXCEEDED', {
    status: 503,
    message: 'Not enough RAM budget, even after sleeping idle imps',
  });
}

function buildRejection(error: Error): Promise<never> {
  return Promise.reject(error);
}

const RANKED = [
  { host: 'a', freeMib: 3 },
  { host: 'b', freeMib: 2 },
  { host: 'c', freeMib: 1 },
];

test('a RAM refusal moves on to the next host, and each host gets one create', async () => {
  const creates: string[] = [];
  const refusals: string[] = [];

  const placed = await createPlaced(
    RANKED,
    (host) => {
      creates.push(host);

      return host === 'a' ? Promise.reject(buildRamError()) : Promise.resolve(`imp on ${host}`);
    },
    (host, message) => {
      refusals.push(`${host}: ${message}`);
    },
  );

  expect(placed).toEqual({ host: 'b', value: 'imp on b' });
  expect(creates).toEqual(['a', 'b']);
  expect(refusals).toEqual(['a: Not enough RAM budget, even after sleeping idle imps']);
});

test('any other failure, a timeout too, ends placement with no second create', async () => {
  const failures: readonly Error[] = [
    new Error('no answer in 5 s'),
    new ORPCError('NOT_FOUND', { message: 'no image myapp' }),
    new ORPCError('FORBIDDEN', { message: 'not allowed' }),
  ];

  for (const failure of failures) {
    const creates: string[] = [];

    const placed = createPlaced(
      RANKED,
      (host) => {
        creates.push(host);

        return buildRejection(failure);
      },
      () => {},
    );

    const rejection = await placed.catch((error: unknown) => error);

    expect(rejection).toBe(failure);
    expect(creates).toEqual(['a']);
  }
});

test('when every host refuses for RAM, placement says so', async () => {
  const creates: string[] = [];

  const placed = createPlaced(
    RANKED,
    (host) => {
      creates.push(host);

      return Promise.reject(buildRamError());
    },
    () => {},
  );

  const rejection = await placed.catch((error: unknown) => error);

  expect(String(rejection)).toBe(
    'Error: every host that could take the imp turned it away for RAM',
  );

  expect(creates).toEqual(['a', 'b', 'c']);
});
