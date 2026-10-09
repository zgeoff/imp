import { expect, onTestFinished, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { findImpByName } from '../db/imps';
import { buildTemplateKey } from '../templates/boot-templates';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubDiskTools } from '../test-utils/build-stub-disk-tools';
import { buildTestApp, createImpTest, findBrokenInvariants } from './test-imps';

// Cold boots with IMP_BOOT_TEMPLATES on, over the stub VMM: the first boot
// of a shape boots the kernel and builds the template beside it; later ones
// restore it (docs/architecture/boot-templates.md).

async function setupTest(
  config: Readonly<{
    // every VM runs under the jailer, in a cgroup of its own
    isJailed?: boolean;
  }> = {},
) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const isJailed = config.isJailed ?? false;

  // a cgroup for every VM, as a jailed start needs
  const cgroups = buildStubCpuCgroups();

  // the host's clone and filesystem grow, which a test fails or holds
  const disk = buildStubDiskTools();

  const harness = await createImpTest(stack, {
    ...(isJailed && { cgroups: cgroups.cgroups }),
    env: {
      IMP_BOOT_TEMPLATES: 'true',
      IMP_JAILER: String(isJailed),
    },
    cloneDisk: disk.cloneDisk,
    growFilesystem: disk.growFilesystem,
  });

  // the image every imp boots from
  await harness.createTestImage('ubuntu');

  const templates = harness.imps.bootTemplates;

  invariant(templates, 'IMP_BOOT_TEMPLATES is on, but impd has no templates');

  return { ...harness, client: buildTestApp(harness, harness).client, templates, disk };
}

test('it boots the kernel for the first boot of a shape and builds no template', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['once']);
  expect(ctx.fake.templateBuilds).toBeEmpty();
});

test('it builds the template on the second boot of a shape, and the next restores it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();
  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  const second = await findImpByName(ctx.db, 'second');

  expect(ctx.fake.templateBuilds).toStrictEqual([{ vcpus: 1, memoryMib: 256 }]);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['once', 'first']);

  expect(ctx.fake.restores).toStrictEqual([
    {
      hostname: 'second',
      isIdentityReset: false,
      memFile: join(ctx.dataDir, 'templates', key, 'mem'),
    },
  ]);

  expect(second?.state).toBe('running');

  expect(ctx.logs).toSatisfyAny(
    (line: string) =>
      line.includes('second: restored boot template') && line.includes(key.slice(0, 12)),
  );
});

test('it leaves no broken record behind once a restored imp settles', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();
  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });
  await ctx.imps.waitForLifecycle();

  const broken = await findBrokenInvariants(ctx, false);

  expect(broken).toBeEmpty();
});

// a template has no hot-plug region, so it would restore a guest that cannot grow
test('it boots the kernel for an elastic imp even when its memory has a template', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'elastic', vcpus: 1, memoryMib: 256, maxMemoryMib: 1024 });
  await ctx.client.imps.create({ name: 'plain', vcpus: 1, memoryMib: 256 });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first', 'elastic']);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['plain']);
  expect(ctx.fake.templateBuilds).toStrictEqual([{ vcpus: 1, memoryMib: 256 }]);
});

test('it removes a template whose restore fails in it, and boots the kernel', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  ctx.fake.queue('restore', 'fail');

  const second = await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  expect(second.state).toBe('running');
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first', 'second']);

  expect(ctx.logs).toSatisfyAny(
    (line: string) =>
      line.includes('failed, booting the kernel') && line.includes(key.slice(0, 12)),
  );

  expect(readdirSync(join(ctx.dataDir, 'templates'))).not.toContain(key);
});

test('it keeps the template for the next imp after a restore fails past the claim', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  ctx.fake.queue('claim', 'fail');

  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'third', vcpus: 1, memoryMib: 256 });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first', 'second']);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['third']);
  expect(ctx.fake.templateBuilds).toHaveLength(1);
});

test('it fails a create whose clone fails before any restore', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  ctx.disk.setCloneFailing(true);

  const creating = ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  expect(creating).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(ctx.fake.restorePlans).toBeEmpty();
});

test('it keeps the template through more failed clones than turn a key off', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  const aliveBefore = ctx.fake.alive.size;

  ctx.disk.setCloneFailing(true);

  // more than the restore failures that would turn the key off
  const second = await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 }).then(
    () => 'created',
    () => 'failed',
  );

  const third = await ctx.client.imps.create({ name: 'third', vcpus: 1, memoryMib: 256 }).then(
    () => 'created',
    () => 'failed',
  );

  const fourth = await ctx.client.imps.create({ name: 'fourth', vcpus: 1, memoryMib: 256 }).then(
    () => 'created',
    () => 'failed',
  );

  ctx.disk.setCloneFailing(false);

  await ctx.client.imps.create({ name: 'fifth', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  expect([second, third, fourth]).toStrictEqual(['failed', 'failed', 'failed']);

  // no VM started for them, none booted the kernel, and the template stays
  expect(ctx.fake.alive.size).toBe(aliveBefore + 1);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first']);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toContain(key);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['fifth']);
});

test('it ends the restored VM when the grow after the clone fails, and keeps the template', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  const aliveBefore = ctx.fake.alive.size;

  // a clone that lands no disk fails the grow after it
  ctx.disk.setCloneEmpty(true);

  // more than the restore failures that would turn the key off, one at a
  // time, as each takes the template's claim
  const second = await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 }).then(
    () => 'created',
    () => 'failed',
  );

  const third = await ctx.client.imps.create({ name: 'third', vcpus: 1, memoryMib: 256 }).then(
    () => 'created',
    () => 'failed',
  );

  const fourth = await ctx.client.imps.create({ name: 'fourth', vcpus: 1, memoryMib: 256 }).then(
    () => 'created',
    () => 'failed',
  );

  ctx.disk.setCloneEmpty(false);

  await ctx.client.imps.create({ name: 'fifth', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  expect([second, third, fourth]).toStrictEqual(['failed', 'failed', 'failed']);

  // each restore started, its VM ended, none booted the kernel, and the
  // template stays
  expect(ctx.fake.restorePlans.map((plan) => plan.claim.hostname)).toStrictEqual([
    'second',
    'third',
    'fourth',
    'fifth',
  ]);

  expect(ctx.fake.alive.size).toBe(aliveBefore + 1);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['first']);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toContain(key);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['fifth']);
});

test('it claims the identity reset an imp owes with a restore, and clears it once done', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.stop({ name: 'first' });
  await ctx.db.updateTable('imps').set({ identity_reset_pending: 1 }).execute();
  await ctx.client.imps.start({ name: 'first' });

  const first = await findImpByName(ctx.db, 'first');

  expect(ctx.fake.restores.map((restore) => restore.isIdentityReset)).toStrictEqual([true]);
  expect(first?.isIdentityResetPending).toBe(false);
});

test('it never waits for the template build of a shape with no template yet', async () => {
  const ctx = await setupTest();

  const held = ctx.fake.hold('template');

  onTestFinished(() => {
    held.release();
  });

  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });

  const created = await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });

  await held.reached;

  expect(created.state).toBe('running');
});

test('it runs a jailed restore as the imp, with the template and its drive bound in', async () => {
  const ctx = await setupTest({ isJailed: true });

  await ctx.client.imps.create({ name: 'once', vcpus: 1, memoryMib: 256 });
  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.stop();
  await ctx.client.imps.create({ name: 'second', vcpus: 1, memoryMib: 256 });

  const key = buildTemplateKey(ctx.readIdentity(), { vcpus: 1, memoryMib: 256 });

  const second = await findImpByName(ctx.db, 'second');

  const dir = join(ctx.dataDir, 'templates');

  invariant(second?.jailUid);

  // a restore that fell back to the kernel would be a boot here
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toStrictEqual(['once', 'first']);
  expect(ctx.fake.restorePlans).toHaveLength(1);

  expect(ctx.fake.restorePlans[0]).toMatchObject({
    jail: { uid: second.jailUid, gid: second.jailUid },
    vmstate: join(dir, key, 'vmstate'),
    memFile: join(dir, key, 'mem'),
    systemDrivePath: ctx.readIdentity().systemDrivePath,
    placeholderPath: join(dir, 'placeholder.ext4'),
    cgroup: { procsPath: `/sys/fs/cgroup/imps/${second.id}/cgroup.procs` },
  });
});

// On ZFS the disk is a dataset mounted on imps/<id>/disk. A jail sees only
// the mounts made before its prepare, so a restore that starts first finds
// an empty mountpoint (#147). A held clone stands in for that mount.
test('it starts a jailed restore only once the clone is in place', async () => {
  const ctx = await setupTest({ isJailed: true });

  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  const clone = ctx.disk.holdClone();

  // a disk past the image's filesystem, which the host grows
  const creating = ctx.client.imps.create({
    name: 'second',
    vcpus: 1,
    memoryMib: 256,
    diskMib: 2048,
  });

  await clone.reached;

  const restoresDuringClone = ctx.fake.restorePlans.length;

  clone.release();

  await creating;

  expect(restoresDuringClone).toBe(0);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['second']);
});

test('it overlaps a jailed restore with the grow of its disk', async () => {
  const ctx = await setupTest({ isJailed: true });

  await ctx.client.imps.create({ name: 'first', vcpus: 1, memoryMib: 256 });
  await ctx.templates.buildTemplate({ vcpus: 1, memoryMib: 256 });

  const grow = ctx.disk.holdGrow();

  onTestFinished(() => {
    grow.release();
  });

  // a disk past the image's filesystem, which the host grows
  const creating = ctx.client.imps.create({
    name: 'second',
    vcpus: 1,
    memoryMib: 256,
    diskMib: 2048,
  });

  await grow.reached;

  // a restore that waited for the grow would never start while it is held
  await waitFor(() => {
    expect(ctx.fake.restorePlans).toHaveLength(1);
  });

  grow.release();

  const second = await creating;

  expect(second.state).toBe('running');
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toStrictEqual(['second']);
});
