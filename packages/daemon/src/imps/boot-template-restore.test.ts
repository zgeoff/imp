import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findImpByName } from '../db/imps';
import { buildTemplateKey } from '../templates/boot-templates';
import { buildTestApp, findBrokenInvariants, setupImpTest } from './test-imps';

// Cold boots with IMP_BOOT_TEMPLATES on, over the fake VMM: the first boot
// of a shape boots the kernel and builds the template beside it; later ones
// restore it (docs/architecture/boot-templates.md).

const SHAPE = { vcpus: 1, memoryMib: 256 };

async function setupRestoreTest() {
  const harness = await setupImpTest({
    env: { IMP_BOOT_TEMPLATES: 'true', IMP_DEFAULT_MEMORY_MIB: '256', IMP_DEFAULT_VCPUS: '1' },
  });

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);
  const templates = harness.imps.bootTemplates;

  if (templates === null) {
    throw new Error('IMP_BOOT_TEMPLATES is on, but impd has no templates');
  }

  // the template a first boot started in the background
  const waitForTemplate = () => templates.buildTemplate(SHAPE);

  return { ...harness, client: app.client, templates, waitForTemplate };
}

test('the first boot of a shape boots the kernel; the next restores its template', async () => {
  await using ctx = await setupRestoreTest();

  await ctx.client.imps.create({ name: 'first' });
  await ctx.waitForTemplate();
  await ctx.client.imps.create({ name: 'second' });

  const key = buildTemplateKey(ctx.readIdentity(), SHAPE);

  const second = await findImpByName(ctx.db, 'second');

  expect(ctx.fake.templateBuilds).toEqual([SHAPE]);
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toEqual(['first']);

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

test('a template that fails to restore goes, and the imp boots the kernel', async () => {
  await using ctx = await setupRestoreTest();

  await ctx.client.imps.create({ name: 'first' });
  await ctx.waitForTemplate();

  ctx.fake.queue('restore', 'fail');

  const second = await ctx.client.imps.create({ name: 'second' });

  const key = buildTemplateKey(ctx.readIdentity(), SHAPE);

  expect(second.state).toBe('running');
  expect(ctx.fake.boots.map((boot) => boot.hostname)).toEqual(['first', 'second']);

  const failedLog = ctx.logs.find((line) => line.includes('failed, booting the kernel'));

  expect(failedLog).toContain(key.slice(0, 12));

  // the miss behind the discard built it again
  await ctx.waitForTemplate();

  expect(ctx.fake.templateBuilds).toHaveLength(2);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toContain(key);
});

test('a restore claims the identity reset an imp owes, and a done reset clears it', async () => {
  await using ctx = await setupRestoreTest();

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
  await using ctx = await setupRestoreTest();

  const held = ctx.fake.hold('template');

  const created = await ctx.client.imps.create({ name: 'first' });

  await held.reached;

  expect(created.state).toBe('running');

  held.release();

  await ctx.waitForTemplate();
});
