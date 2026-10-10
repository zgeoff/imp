import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { findImpByName, updateImpActivity } from '../db/imps';
import { hasSnapshot } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { createCpuCgroups } from '../vmm/cpu-cgroups';
import { buildTestApp, createImpTest } from './test-imps';
import type { ImpTestOptions } from './test-imps';

// impd over the stub VMM with the cgroups and host a test passes, and a
// client of its API
async function setupTest(
  options: Pick<ImpTestOptions, 'env' | 'cgroups' | 'hostCpus' | 'frozenClockMs'> = {},
) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, options);

  // every create boots an image row; the default image is ubuntu
  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  return { ...harness, client: app.client };
}

test('it boots a new imp with the limit and weight it was given', async () => {
  const stub = buildStubCpuCgroups();

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const created = await ctx.client.imps.create({ name: 'dev', cpuLimit: 1.5, cpuWeight: 200 });

  expect(created.cpu).toStrictEqual({ limit: 1.5, weight: 200 });

  // the memory limit of a 2 GiB guest comes first
  expect(stub.calls).toStrictEqual([`memory ${created.id} 2048`, `setup ${created.id} 1.5/200`]);
});

test('it boots a fork with the limit and weight of its source', async () => {
  const stub = buildStubCpuCgroups();

  const ctx = await setupTest({ cgroups: stub.cgroups });

  await ctx.client.imps.create({ name: 'dev', cpuLimit: 1.5, cpuWeight: 200 });

  const forked = await ctx.client.imps.fork({ source: 'dev', name: 'copy' });

  expect(forked.cpu).toStrictEqual({ limit: 1.5, weight: 200 });
  expect(stub.readGroup(forked.id)?.cpu).toStrictEqual({ limit: 1.5, weight: 200 });
});

test('it applies a new limit to a running imp at once', async () => {
  const stub = buildStubCpuCgroups();

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const created = await ctx.client.imps.create({ name: 'dev' });
  const running = await ctx.client.imps.update({ name: 'dev', cpuLimit: 0.5 });

  expect(running.cpu).toStrictEqual({ limit: 0.5, weight: 100 });

  expect(stub.calls).toStrictEqual([
    `memory ${created.id} 2048`,
    `setup ${created.id} null/100`,
    `apply ${created.id} 0.5/100`,
  ]);
});

test('it applies new settings to a sleeping imp at its wake', async () => {
  const stub = buildStubCpuCgroups();

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const created = await ctx.client.imps.create({ name: 'dev', cpuLimit: 0.5 });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.update({ name: 'dev', cpuLimit: null, cpuWeight: 300 });
  await ctx.client.imps.wake({ name: 'dev' });

  // the create, the sleep and the wake each set the cgroup up, and only the
  // wake takes the new settings; a sleep keeps the cgroup for the wake
  expect(stub.calls).toStrictEqual([
    `memory ${created.id} 2048`,
    `setup ${created.id} 0.5/100`,
    `setup ${created.id} 0.5/100`,
    `setup ${created.id} null/300`,
    `memory ${created.id} 2048`,
  ]);
});

test('it removes the cgroup of an imp that stops', async () => {
  const stub = buildStubCpuCgroups();

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.stop({ name: 'dev' });

  expect(stub.calls.at(-1)).toBe(`remove ${created.id}`);
});

test('it sets the HTTP port and leaves the CPU settings as they were', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', cpuLimit: 1.5 });

  const updated = await ctx.client.imps.update({ name: 'dev', httpPort: 3000 });
  const read = await ctx.client.imps.get({ name: 'dev' });

  expect(updated.httpPort).toBe(3000);
  expect(read.httpPort).toBe(3000);
  expect(read.cpu).toStrictEqual({ limit: 1.5, weight: 100 });
});

test('it refuses a vCPU count change on a running imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.client.imps.update({ name: 'dev', vcpus: 4 })).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
});

test('it changes the vCPU count of a stopped imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const stopped = await ctx.client.imps.update({ name: 'dev', vcpus: 4 });

  expect(stopped.vcpus).toBe(4);
});

test('it refuses a limit above the host cores', async () => {
  const ctx = await setupTest({ hostCpus: 4 });

  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.client.imps.update({ name: 'dev', cpuLimit: 5 })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it refuses a limit below a tenth of a core', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.client.imps.update({ name: 'dev', cpuLimit: 0.05 })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it refuses a weight of zero', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.client.imps.update({ name: 'dev', cpuWeight: 0 })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it counts a wake and opens an awake span', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const awake = await findImpByName(ctx.db, 'dev');

  expect(awake?.wakeCount).toBe(1);
  expect(awake?.awakeSince).toBeValidDate();
});

test('it ends the awake span of a VM found dead at its last activity', async () => {
  const stub = buildStubCpuCgroups();

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const awake = await findImpByName(ctx.db, 'dev');

  invariant(awake?.awakeSince);
  invariant(awake.pid);

  // the VM was last active 2 s into its span, then died
  await updateImpActivity(ctx.db, created.id, new Date(awake.awakeSince.getTime() + 2000));

  ctx.fake.alive.delete(awake.pid);

  const api = await ctx.client.imps.get({ name: 'dev' });
  const repaired = await findImpByName(ctx.db, 'dev');

  expect(api.state).toBe('stopped');
  expect(stub.calls.at(-1)).toBe(`remove ${created.id}`);
  expect(repaired?.awakeSince).toBeNull();
  expect(repaired?.awakeMs).toBe(awake.awakeMs + 2000);
  expect(api.resources).toMatchObject({ wakeCount: 1, awakeMs: awake.awakeMs + 2000 });
});

test('it counts a cold boot for a wake as a wake', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');

  const cold = await ctx.client.imps.wake({ name: 'dev' });

  expect(cold.state).toBe('running');
  expect(cold.resources?.wakeCount).toBe(1);
});

test('it shows RAM but no CPU share from the first sampler pass', async () => {
  const stub = buildStubCpuCgroups();

  const ctx = await setupTest({ cgroups: stub.cgroups });

  await ctx.client.imps.create({ name: 'dev' });

  const first = await ctx.client.imps.get({ name: 'dev' });

  invariant(first.resources?.sample);

  // createImpTest's VMs each own 300 MiB while alive, as the governor reads them
  expect(first.ramMib).toBe(300);
  expect(first.resources.sample.cpuPercent).toBeUndefined();
});

test('it shows the CPU share and the throttled time after a second sampler pass', async () => {
  const stub = buildStubCpuCgroups();

  // a frozen clock: the 5 s between the passes is exactly 5 s
  const ctx = await setupTest({
    cgroups: stub.cgroups,
    frozenClockMs: Date.parse('2026-10-02T12:00:00Z'),
  });

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.get({ name: 'dev' });

  // half a core for 5 s from a new cgroup's zero counters, 2 s of it held back
  ctx.advance(5000);
  stub.cpuStats.set(created.id, { usageUsec: 2_500_000, throttledUsec: 2_000_000 });

  await ctx.imps.sampleResources();

  const second = await ctx.client.imps.get({ name: 'dev' });

  expect(second.resources?.sample?.cpuPercent).toBe(50);
  expect(second.resources?.sample?.cpuThrottledMs).toBe(2000);
});

test('it refuses to start a jailed VM without its cgroup, and says why', async () => {
  // the default cgroups: no controller is delegated
  const ctx = await setupTest({ env: { IMP_JAILER: 'true' } });

  expect(ctx.imps.createImp({ name: 'dev' })).rejects.toStrictEqual(
    new Error(
      'a jailed VM starts only in its own cgroup, and it has none: the cpu controller is not delegated to /sys/fs/cgroup/imps, or the setup of imps/<id> failed (see the log); set IMP_JAILER=false on a host without cgroup delegation',
    ),
  );

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp?.state).toBe('error');
  expect(imp?.error).toContain('set IMP_JAILER=false');
  expect(ctx.fake.boots).toBeEmpty();
});

test('it leaves a jailed imp asleep, with its memory, when its cgroup cannot be made at the wake', async () => {
  // a cgroup tree with the cpu controller delegated to imps/
  const cgroupRoot = mkdtempSync(join(tmpdir(), 'imp-cgroups-'));

  onTestFinished(() => {
    rmSync(cgroupRoot, { recursive: true, force: true });
  });

  mkdirSync(join(cgroupRoot, 'imps'));
  writeFileSync(join(cgroupRoot, 'imps', 'cgroup.subtree_control'), 'cpu');

  const ctx = await setupTest({
    cgroups: createCpuCgroups({ root: cgroupRoot, log: () => {} }),
    env: { IMP_JAILER: 'true' },
  });

  const created = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.sleepImp('dev');

  // a file where the imp's cgroup directory goes makes its setup fail
  const groupDir = join(cgroupRoot, 'imps', created.id);

  rmSync(groupDir, { recursive: true, force: true });
  writeFileSync(groupDir, '');

  expect(ctx.imps.wakeImp('dev')).rejects.toStrictEqual(
    new Error(
      'a jailed VM starts only in its own cgroup, and it has none: the cpu controller is not delegated to /sys/fs/cgroup/imps, or the setup of imps/<id> failed (see the log); set IMP_JAILER=false on a host without cgroup delegation',
    ),
  );

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp?.state).toBe('sleeping');
  expect(hasSnapshot(buildImpPaths(ctx.dataDir, created.id))).toBeTrue();
  expect(ctx.fake.wakes).toBeEmpty();
});

test('it wakes a jailed imp once its cgroup can be made again', async () => {
  // a cgroup tree with the cpu controller delegated to imps/
  const cgroupRoot = mkdtempSync(join(tmpdir(), 'imp-cgroups-'));

  onTestFinished(() => {
    rmSync(cgroupRoot, { recursive: true, force: true });
  });

  mkdirSync(join(cgroupRoot, 'imps'));
  writeFileSync(join(cgroupRoot, 'imps', 'cgroup.subtree_control'), 'cpu');

  const ctx = await setupTest({
    cgroups: createCpuCgroups({ root: cgroupRoot, log: () => {} }),
    env: { IMP_JAILER: 'true' },
  });

  const created = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.sleepImp('dev');

  const groupDir = join(cgroupRoot, 'imps', created.id);

  rmSync(groupDir, { recursive: true, force: true });
  writeFileSync(groupDir, '');

  const [refused] = await Promise.allSettled([ctx.imps.wakeImp('dev')]);

  rmSync(groupDir);

  const woken = await ctx.imps.wakeImp('dev');

  expect(refused).toStrictEqual({
    status: 'rejected',
    reason: new Error(
      'a jailed VM starts only in its own cgroup, and it has none: the cpu controller is not delegated to /sys/fs/cgroup/imps, or the setup of imps/<id> failed (see the log); set IMP_JAILER=false on a host without cgroup delegation',
    ),
  });

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toHaveLength(1);
});
