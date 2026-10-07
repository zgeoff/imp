import { expect, test } from 'bun:test';
import { buildStubCpuCgroups } from './build-stub-cpu-cgroups';

test('it hands back the procs path of the cgroup an enforced setup makes', () => {
  expect(
    buildStubCpuCgroups().cgroups.setup('imp-a', { limit: 1.5, weight: 200 }, 2048)?.procsPath,
  ).toBe('/sys/fs/cgroup/imps/imp-a/cgroup.procs');
});

test('it makes a cgroup with the settings an enforced setup gives', () => {
  const stub = buildStubCpuCgroups();

  stub.cgroups.setup('imp-a', { limit: 1.5, weight: 200 }, 2048);

  expect(stub.readGroup('imp-a')).toStrictEqual({
    cpu: { limit: 1.5, weight: 200 },
    memoryMib: 2048,
    guestMib: null,
    pids: [],
  });
});

test('it hands back no cgroup on a host whose cpu controller is not delegated', () => {
  expect(
    buildStubCpuCgroups({ isEnforced: false }).cgroups.setup(
      'imp-a',
      { limit: null, weight: 100 },
      512,
    ),
  ).toBeNull();
});

test('it makes no cgroup on a host whose cpu controller is not delegated', () => {
  const stub = buildStubCpuCgroups({ isEnforced: false });

  stub.cgroups.setup('imp-a', { limit: null, weight: 100 }, 512);

  expect(stub.listGroups()).toStrictEqual([]);
});

test.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
  [false, false, false],
])(
  'it reports, with the cpu controller %p and memory asked for %p, the memory controller on as %p',
  (isEnforced, isMemoryAsked, isMemoryEnforced) => {
    const stub = buildStubCpuCgroups({ isEnforced, isMemoryEnforced: isMemoryAsked });

    expect(stub.cgroups.isMemoryEnforced).toBe(isMemoryEnforced);
  },
);

test('it reports the memory controller off when memory is not asked for', () => {
  const stub = buildStubCpuCgroups();

  expect(stub.cgroups.isMemoryEnforced).toBeFalse();
});

test('it records every change to a cgroup in the order impd asks for it', async () => {
  const stub = buildStubCpuCgroups();

  stub.cgroups.setup('imp-a', { limit: 1, weight: 100 }, 512);
  stub.cgroups.apply('imp-a', { limit: 2, weight: 50 });
  stub.cgroups.setGuestMib('imp-a', 1024);
  stub.cgroups.kill('imp-a');

  await stub.cgroups.remove('imp-a');

  expect(stub.calls).toStrictEqual([
    'setup imp-a 1/100',
    'apply imp-a 2/50',
    'memory imp-a 1024',
    'kill imp-a',
    'remove imp-a',
  ]);
});

test('it records a lift of the limit through the cgroup setup hands back', () => {
  const stub = buildStubCpuCgroups();

  stub.cgroups.setup('imp-a', { limit: 1, weight: 100 }, 512)?.liftLimit();
  expect(stub.calls).toStrictEqual(['setup imp-a 1/100', 'lift imp-a']);
});

test('it records the limit put back through the cgroup setup hands back', () => {
  const stub = buildStubCpuCgroups();

  stub.cgroups.setup('imp-a', { limit: 1, weight: 100 }, 512)?.applyLimit();
  expect(stub.calls).toStrictEqual(['setup imp-a 1/100', 'limit imp-a']);
});

test('it keeps new settings and the guest size on a cgroup a VM runs in', () => {
  const stub = buildStubCpuCgroups();

  stub.cgroups.setup('imp-a', { limit: 1, weight: 100 }, 512);
  stub.cgroups.apply('imp-a', { limit: 3, weight: 300 });
  stub.cgroups.setGuestMib('imp-a', 768);

  expect(stub.readGroup('imp-a')).toStrictEqual({
    cpu: { limit: 3, weight: 300 },
    memoryMib: 512,
    guestMib: 768,
    pids: [],
  });
});

test('it moves an adopted VM into its cgroup', () => {
  const stub = buildStubCpuCgroups();

  stub.cgroups.adopt('imp-a', 4242, { limit: null, weight: 100 }, 1024);

  expect(stub.readGroup('imp-a')).toStrictEqual({
    cpu: { limit: null, weight: 100 },
    memoryMib: 1024,
    guestMib: null,
    pids: [4242],
  });
});

test('it records an adoption but makes no cgroup on a host without a cpu controller', () => {
  const stub = buildStubCpuCgroups({ isEnforced: false });

  stub.cgroups.adopt('imp-a', 4242, { limit: null, weight: 100 }, 1024);

  expect({ calls: stub.calls, groups: stub.listGroups() }).toStrictEqual({
    calls: ['adopt imp-a 4242'],
    groups: [],
  });
});

test('it removes the cgroup of every imp not in the set and returns their ids', () => {
  const stub = buildStubCpuCgroups();

  stub.cgroups.setup('imp-a', { limit: null, weight: 100 }, 512);
  stub.cgroups.setup('imp-b', { limit: null, weight: 100 }, 512);
  stub.cgroups.setup('imp-c', { limit: null, weight: 100 }, 512);

  const removed = stub.cgroups.removeOrphans(new Set(['imp-b']));

  expect(removed).toStrictEqual(['imp-a', 'imp-c']);
  expect(stub.listGroups()).toStrictEqual(['imp-b']);
});

test('it never removes the cgroup of an imp in the set', () => {
  const stub = buildStubCpuCgroups();

  stub.cgroups.setup('imp-a', { limit: null, weight: 100 }, 512);

  const removed = stub.cgroups.removeOrphans(new Set(['imp-a']));

  expect(removed).toStrictEqual([]);
  expect(stub.listGroups()).toStrictEqual(['imp-a']);
});

test('it reads no OOM kill count and no cpu.stat for an imp without a cgroup', () => {
  const stub = buildStubCpuCgroups();

  stub.oomKills.set('imp-a', 2);
  stub.cpuStats.set('imp-a', { usageUsec: 10, throttledUsec: 1 });

  expect(stub.cgroups.readOomKills('imp-a')).toBeNull();
  expect(stub.cgroups.readCpuStat('imp-a')).toBeNull();
});

test('it reads the OOM kill count and cpu.stat the test set for a cgroup', () => {
  const stub = buildStubCpuCgroups();

  stub.cgroups.setup('imp-a', { limit: null, weight: 100 }, 512);
  stub.oomKills.set('imp-a', 2);
  stub.cpuStats.set('imp-a', { usageUsec: 10, throttledUsec: 1 });

  expect(stub.cgroups.readOomKills('imp-a')).toBe(2);
  expect(stub.cgroups.readCpuStat('imp-a')).toStrictEqual({ usageUsec: 10, throttledUsec: 1 });
});

test('it reports no OOM kill since start for kills from before the VM started', () => {
  const stub = buildStubCpuCgroups();

  stub.oomKills.set('imp-a', 3);
  stub.cgroups.setup('imp-a', { limit: null, weight: 100 }, 512);

  expect(stub.cgroups.hasOomKillSinceStart('imp-a')).toBeFalse();
});

test('it reports an OOM kill since start once the count rises after setup', () => {
  const stub = buildStubCpuCgroups();

  stub.oomKills.set('imp-a', 3);
  stub.cgroups.setup('imp-a', { limit: null, weight: 100 }, 512);
  stub.oomKills.set('imp-a', 4);

  expect(stub.cgroups.hasOomKillSinceStart('imp-a')).toBeTrue();
});
