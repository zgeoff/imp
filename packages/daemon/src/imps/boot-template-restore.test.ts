import { expect, test } from 'bun:test';
import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findImpByName } from '../db/imps';
import { buildTemplateKey } from '../templates/boot-templates';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import { buildTestApp, findBrokenInvariants, setupImpTest } from './test-imps';

// Cold boots with IMP_BOOT_TEMPLATES on, over the fake VMM: the first boot
// of a shape boots the kernel and builds the template beside it; later ones
// restore it (docs/architecture/boot-templates.md).

const SHAPE = { vcpus: 1, memoryMib: 256 };

// a cgroup for every VM, as a jailed start needs
const JAIL_CGROUPS: CpuCgroups = {
  isEnforced: true,
  isMemoryEnforced: true,
  readOomKills: () => null,
  hasOomKillSinceStart: () => false,
  setup: (impId) => ({
    procsPath: `/cg/${impId}/cgroup.procs`,
    liftLimit: () => {},
    applyLimit: () => {},
  }),
  apply: () => {},
  adopt: () => {},
  remove: () => Promise.resolve(),
  setGuestMib: () => {},
  kill: () => {},
  removeOrphans: () => [],
  readCpuStat: () => null,
};

// With `isJailed`, every VM runs under the jailer. The knobs below hold the
// disk's steps back, fail them, or see them end, until a test sets them back.
async function setupRestoreTest(isJailed = false) {
  // turns every disk clone away
  const cloneFails = { isOn: false };

  // `isEmpty` lands no disk, so the grow after the clone fails; a failed
  // filesystem grow is only logged, and the guest grows it at boot
  const clone: { delayMs: number; isEmpty: boolean; onDone?: () => void } = {
    delayMs: 0,
    isEmpty: false,
  };

  // the host's grow of the filesystem, which a template restore overlaps
  const grow: { delayMs: number; onDone?: () => void } = { delayMs: 0 };

  const harness = await setupImpTest({
    ...(isJailed && { cgroups: JAIL_CGROUPS }),
    env: {
      IMP_BOOT_TEMPLATES: 'true',
      IMP_DEFAULT_MEMORY_MIB: '256',
      IMP_DEFAULT_VCPUS: '1',
      IMP_JAILER: String(isJailed),
    },
    cloneDisk: async (source, target) => {
      await Bun.sleep(clone.delayMs);

      if (cloneFails.isOn) {
        throw new Error('clone failed: no space');
      }

      if (!clone.isEmpty) {
        copyFileSync(source, target);
      }

      clone.onDone?.();
    },
    growFilesystem: async () => {
      await Bun.sleep(grow.delayMs);

      grow.onDone?.();

      return true;
    },
  });

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);
  const templates = harness.imps.bootTemplates;

  if (templates === null) {
    throw new Error('IMP_BOOT_TEMPLATES is on, but impd has no templates');
  }

  // the template a first boot started in the background
  const waitForTemplate = () => templates.buildTemplate(SHAPE);

  return { ...harness, client: app.client, templates, waitForTemplate, cloneFails, clone, grow };
}

test('the second boot of a shape builds its template; the next restores it', async () => {
  const ctx = await setupRestoreTest();

  await ctx.client.imps.create({ name: 'once' });

  expect(ctx.fake.templateBuilds).toEqual([]);

  await ctx.client.imps.create({ name: 'first' });
  await ctx.imps.bootTemplates?.stop();
  await ctx.client.imps.create({ name: 'second' });

  const key = buildTemplateKey(ctx.readIdentity(), SHAPE);

  const second = await findImpByName(ctx.db, 'second');

  expect(ctx.fake.templateBuilds).toEqual([SHAPE]);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toEqual(['once', 'first']);

  expect(ctx.fake.restores).toEqual([
    {
      hostname: 'second',
      isIdentityReset: false,
      memFile: join(ctx.dataDir, 'templates', key, 'mem'),
    },
  ]);

  expect(second?.state).toBe('running');

  const restoredLog = ctx.logs.find((line) => line.includes('second: restored boot template'));

  expect(restoredLog).toContain(key.slice(0, 12));

  await ctx.imps.waitForLifecycle();

  const broken = await findBrokenInvariants(ctx, false);

  expect(broken).toEqual([]);
});

// a template has no hot-plug region, so it would restore a guest that cannot grow
test('an elastic imp boots the kernel even when its memory has a template', async () => {
  const ctx = await setupRestoreTest();

  await ctx.client.imps.create({ name: 'first' });
  await ctx.waitForTemplate();
  await ctx.client.imps.create({ name: 'elastic', maxMemoryMib: 1024 });
  await ctx.client.imps.create({ name: 'plain' });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toEqual(['first', 'elastic']);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toEqual(['plain']);
  expect(ctx.fake.templateBuilds).toEqual([SHAPE]);
});

test('a restore that fails in the template removes it; the imp boots the kernel', async () => {
  const ctx = await setupRestoreTest();

  await ctx.client.imps.create({ name: 'first' });
  await ctx.waitForTemplate();

  ctx.fake.queue('restore', 'fail');

  const second = await ctx.client.imps.create({ name: 'second' });

  const key = buildTemplateKey(ctx.readIdentity(), SHAPE);

  expect(second.state).toBe('running');
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toEqual(['first', 'second']);

  const failedLog = ctx.logs.find((line) => line.includes('failed, booting the kernel'));

  expect(failedLog).toContain(key.slice(0, 12));
  expect(readdirSync(join(ctx.dataDir, 'templates'))).not.toContain(key);
});

test('a restore that fails after the claim keeps the template for the next imp', async () => {
  const ctx = await setupRestoreTest();

  await ctx.client.imps.create({ name: 'first' });
  await ctx.waitForTemplate();

  ctx.fake.queue('claim', 'fail');

  await ctx.client.imps.create({ name: 'second' });
  await ctx.client.imps.create({ name: 'third' });

  expect(ctx.fake.boots.map((boot) => boot.hostname)).toEqual(['first', 'second']);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toEqual(['third']);
  expect(ctx.fake.templateBuilds).toHaveLength(1);
});

test('a clone that fails fails the create before any restore, and costs the template nothing', async () => {
  const ctx = await setupRestoreTest();

  await ctx.client.imps.create({ name: 'first' });
  await ctx.waitForTemplate();

  const aliveBefore = ctx.fake.alive.size;

  ctx.cloneFails.isOn = true;

  // more than the restore failures that would turn the key off
  for (const name of ['second', 'third', 'fourth']) {
    const failed = await ctx.client.imps.create({ name }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
  }

  const key = buildTemplateKey(ctx.readIdentity(), SHAPE);

  // no VM started, none booted the kernel, and the template stays
  expect(ctx.fake.restorePlans).toEqual([]);
  expect(ctx.fake.alive.size).toBe(aliveBefore);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toEqual(['first']);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toContain(key);

  ctx.cloneFails.isOn = false;

  await ctx.client.imps.create({ name: 'fifth' });

  expect(ctx.fake.restores.map((restore) => restore.hostname)).toEqual(['fifth']);
});

test('a grow that fails after the clone ends the restored VM, and costs the template nothing', async () => {
  const ctx = await setupRestoreTest();

  await ctx.client.imps.create({ name: 'first' });
  await ctx.waitForTemplate();

  const aliveBefore = ctx.fake.alive.size;

  ctx.clone.isEmpty = true;

  // more than the restore failures that would turn the key off
  for (const name of ['second', 'third', 'fourth']) {
    const failed = await ctx.client.imps.create({ name }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
  }

  const key = buildTemplateKey(ctx.readIdentity(), SHAPE);

  // each restore started, its VM ended, none booted the kernel, and the
  // template stays
  expect(ctx.fake.restorePlans.map((plan) => plan.claim.hostname)).toEqual([
    'second',
    'third',
    'fourth',
  ]);

  expect(ctx.fake.alive.size).toBe(aliveBefore);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toEqual(['first']);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toContain(key);

  ctx.clone.isEmpty = false;

  await ctx.client.imps.create({ name: 'fifth' });

  expect(ctx.fake.restores.map((restore) => restore.hostname)).toEqual(['fifth']);
});

test('a restore claims the identity reset an imp owes, and a done reset clears it', async () => {
  const ctx = await setupRestoreTest();

  await ctx.client.imps.create({ name: 'first' });
  await ctx.waitForTemplate();
  await ctx.client.imps.stop({ name: 'first' });
  await ctx.db.updateTable('imps').set({ identity_reset_pending: 1 }).execute();
  await ctx.client.imps.start({ name: 'first' });

  const first = await findImpByName(ctx.db, 'first');

  expect(ctx.fake.restores.map((restore) => restore.isIdentityReset)).toEqual([true]);
  expect(first?.isIdentityResetPending).toBe(false);
});

test('a shape with no template yet never waits for its build', async () => {
  const ctx = await setupRestoreTest();

  const held = ctx.fake.hold('template');

  await ctx.client.imps.create({ name: 'once' });

  const created = await ctx.client.imps.create({ name: 'first' });

  await held.reached;

  expect(created.state).toBe('running');

  held.release();

  await ctx.waitForTemplate();
});

test('a jailed restore runs as the imp, with the template and its drive bound in', async () => {
  const ctx = await setupRestoreTest(true);

  await ctx.client.imps.create({ name: 'once' });
  await ctx.client.imps.create({ name: 'first' });
  await ctx.imps.bootTemplates?.stop();
  await ctx.client.imps.create({ name: 'second' });

  const key = buildTemplateKey(ctx.readIdentity(), SHAPE);

  const second = await findImpByName(ctx.db, 'second');

  const dir = join(ctx.dataDir, 'templates');

  // a restore that fell back to the kernel would be a boot here
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toEqual(['once', 'first']);

  const [plan] = ctx.fake.restorePlans;

  expect(ctx.fake.restorePlans).toHaveLength(1);
  expect(plan?.jail).toEqual({ uid: second?.jailUid ?? -1, gid: second?.jailUid ?? -1 });
  expect(plan?.vmstate).toBe(join(dir, key, 'vmstate'));
  expect(plan?.memFile).toBe(join(dir, key, 'mem'));
  expect(plan?.systemDrivePath).toBe(ctx.readIdentity().systemDrivePath);
  expect(plan?.placeholderPath).toBe(join(dir, 'placeholder.ext4'));
  expect(plan?.cgroup?.procsPath).toBe(`/cg/${second?.id ?? ''}/cgroup.procs`);
});

// On ZFS the disk is a dataset mounted on imps/<id>/disk. A jail sees only
// the mounts made before its prepare, so a restore that starts first finds
// an empty mountpoint (#147). A late clone stands in for that mount.
test('a jailed restore starts once the clone is in place, and overlaps the grow', async () => {
  const ctx = await setupRestoreTest(true);

  await ctx.client.imps.create({ name: 'first' });
  await ctx.waitForTemplate();

  const restoresAtClone: number[] = [];
  const restoresAtGrow: number[] = [];

  ctx.clone.delayMs = 50;
  ctx.grow.delayMs = 50;

  ctx.clone.onDone = () => {
    restoresAtClone.push(ctx.fake.restorePlans.length);
  };

  ctx.grow.onDone = () => {
    restoresAtGrow.push(ctx.fake.restorePlans.length);
  };

  // a disk past the image's filesystem, which the host grows
  await ctx.client.imps.create({ name: 'second', diskMib: 2048 });

  // none before the clone lands; one started while the grow was pending
  expect(restoresAtClone).toEqual([0]);
  expect(restoresAtGrow).toEqual([1]);
  expect(ctx.fake.restores.map((restore) => restore.hostname)).toEqual(['second']);
});
