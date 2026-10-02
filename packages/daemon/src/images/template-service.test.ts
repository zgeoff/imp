import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCheckpointService } from '../checkpoints/checkpoint-service';
import { findImageByName } from '../db/images';
import { findImpByName } from '../db/imps';
import { setupImpTest } from '../imps/test-imps';
import { buildImagePaths, buildImpPaths } from '../storage/data-layout';
import { createTemplateService } from './template-service';

async function setupTest() {
  // freeze, thaw and clone calls in the order they happen
  const events: string[] = [];
  const state = { failClone: false };

  const harness = await setupImpTest({
    cloneDisk: (source, target) => {
      if (state.failClone) {
        return Promise.reject(new Error('clone failed'));
      }

      events.push(`clone ${source.slice(harness.dataDir.length)}`);

      copyFileSync(source, target);

      return Promise.resolve();
    },
  });

  const templates = createTemplateService({
    config: harness.config,
    db: harness.db,
    imps: harness.imps,
    storage: harness.storage,
    storageGate: harness.storageGate,
    diskBudget: harness.diskBudget,
    log: () => {},
    freezer: {
      freeze: () => {
        events.push('freeze');

        return Promise.resolve();
      },
      thaw: () => {
        events.push('thaw');

        return Promise.resolve();
      },
    },
  });

  const checkpoints = createCheckpointService({
    config: harness.config,
    db: harness.db,
    imps: harness.imps,
    storage: harness.storage,
    diskBudget: harness.diskBudget,
    log: () => {},
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  const base = await harness.createTestImage('base');

  writeFileSync(buildImagePaths(harness.dataDir, base.digest).config, '{"User":"dev"}');

  const findDisk = async (name: string): Promise<string> => {
    const imp = await findImpByName(harness.db, name);

    return buildImpPaths(harness.dataDir, imp?.id ?? '').disk;
  };

  return {
    ...harness,
    templates,
    checkpoints,
    events,
    state,
    readDisk: async (name: string) => {
      const disk = await findDisk(name);

      return readFileSync(disk, 'utf8');
    },
    writeDisk: async (name: string, content: string) => {
      const disk = await findDisk(name);

      writeFileSync(disk, content);
    },
  };
}

test('it freezes a running imp around the clone and adds a template image', async () => {
  await using ctx = await setupTest();

  const source = await ctx.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.writeDisk('dev', 'tools installed');

  ctx.events.length = 0;

  const image = await ctx.templates.createTemplate('dev', 'tools');

  expect(ctx.events).toEqual(['freeze', `clone /imps/${source.id}/disk.ext4`, 'thaw']);
  expect(image).toMatchObject({ name: 'tools', ref: 'imp:dev', source: 'imp' });
  expect(image.digest).toMatch(/^imp-[\da-f-]{36}$/);

  const paths = buildImagePaths(ctx.dataDir, image.digest);

  expect(readFileSync(paths.rootfs, 'utf8')).toBe('tools installed');
  expect(readFileSync(paths.config, 'utf8')).toBe('{"User":"dev"}');
});

test('it wakes a sleeping imp first, and copies a stopped one without a freeze', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.imps.sleepImp('dev');

  ctx.events.length = 0;

  await ctx.templates.createTemplate('dev', 'woken');

  expect(ctx.fake.wakes).toHaveLength(1);
  expect(ctx.events[0]).toBe('freeze');

  await ctx.imps.stopImp('dev');

  ctx.events.length = 0;

  await ctx.templates.createTemplate('dev', 'cold');

  expect(ctx.events).toHaveLength(1);
  expect(ctx.events[0]).toStartWith('clone ');
});

test('an imp from a template boots once with an identity reset', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.writeDisk('dev', 'golden');
  await ctx.templates.createTemplate('dev', 'tools');

  ctx.fake.boots.length = 0;

  await ctx.imps.createImp({ name: 'copy', image: 'tools' });

  const disk = await ctx.readDisk('copy');

  expect(disk).toBe('golden');

  const created = await findImpByName(ctx.db, 'copy');

  expect(created?.isIdentityResetPending).toBe(false);

  await ctx.imps.stopImp('copy');
  await ctx.imps.startImp('copy');

  // an imp from a docker image never resets
  await ctx.imps.createImp({ name: 'plain', image: 'base' });

  expect(ctx.fake.boots).toEqual([
    { hostname: 'copy', isIdentityReset: true },
    { hostname: 'copy', isIdentityReset: false },
    { hostname: 'plain', isIdentityReset: false },
  ]);
});

test('an imp from a template made stopped resets on its first boot', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.templates.createTemplate('dev', 'tools');
  await ctx.imps.createImp({ name: 'copy', image: 'tools', start: false });

  const stopped = await findImpByName(ctx.db, 'copy');

  expect(stopped?.isIdentityResetPending).toBe(true);

  ctx.fake.boots.length = 0;

  await ctx.imps.startImp('copy');

  expect(ctx.fake.boots).toEqual([{ hostname: 'copy', isIdentityReset: true }]);
});

test('a template made again moves the name to a new disk and drops the old one', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.writeDisk('dev', 'v1');

  const first = await ctx.templates.createTemplate('dev', 'tools');

  await ctx.imps.createImp({ name: 'old', image: 'tools' });
  await ctx.writeDisk('dev', 'v2');

  const second = await ctx.templates.createTemplate('dev', 'tools');

  expect(second.id).toBe(first.id);
  expect(second.digest).not.toBe(first.digest);
  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).dir)).toBe(false);

  await ctx.imps.createImp({ name: 'new', image: 'tools' });

  const oldDisk = await ctx.readDisk('old');
  const newDisk = await ctx.readDisk('new');

  expect(oldDisk).toBe('v1');
  expect(newDisk).toBe('v2');
});

test('a template and a docker image never share a name', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base' });

  const overDocker = await ctx.templates
    .createTemplate('dev', 'base')
    .catch((error: unknown) => error);

  expect(overDocker).toMatchObject({
    message: 'image base is a docker image; give the template a name of its own',
  });

  await ctx.templates.createTemplate('dev', 'tools');

  // refused before any docker call
  const overTemplate = await ctx.images
    .addImage('ubuntu:24.04', 'tools')
    .catch((error: unknown) => error);

  expect(overTemplate).toMatchObject({
    message: 'image tools is a template; make it again from an imp, or pick another name',
  });

  const tools = await findImageByName(ctx.db, 'tools');

  expect(tools?.source).toBe('imp');
});

test('an imp from a template gets at least the template disk', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base', diskMib: 64 });
  await ctx.templates.createTemplate('dev', 'tools');

  const tooSmall = await ctx.imps
    .createImp({ name: 'small', image: 'tools', diskMib: 32 })
    .catch((error: unknown) => error);

  expect(tooSmall).toMatchObject({
    message: "a disk of 32 MiB is smaller than template tools's disk (64 MiB)",
  });

  const sized = await ctx.imps.createImp({ name: 'sized', image: 'tools' });

  expect(sized.diskMib).toBe(64);
});

test('a template no imp uses can be removed; one in use cannot', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base' });

  const image = await ctx.templates.createTemplate('dev', 'tools');

  await ctx.imps.createImp({ name: 'copy', image: 'tools' });

  const inUse = await ctx.images.removeImage('tools').catch((error: unknown) => error);

  expect(inUse).toMatchObject({ message: 'image tools is used by 1 imp(s)' });

  await ctx.imps.destroyImp('copy');
  await ctx.images.removeImage('tools');

  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).dir)).toBe(false);
});

test('a fork of a template copy that never booted owes the reset too', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.templates.createTemplate('dev', 'tools');
  await ctx.imps.createImp({ name: 'copy', image: 'tools', start: false });

  ctx.fake.boots.length = 0;

  await ctx.checkpoints.forkImp({ source: 'copy', name: 'fork' });

  // a fork of a booted copy holds that copy's new identity already
  await ctx.imps.startImp('copy');
  await ctx.checkpoints.forkImp({ source: 'copy', name: 'later' });

  expect(ctx.fake.boots).toEqual([
    { hostname: 'fork', isIdentityReset: true },
    { hostname: 'copy', isIdentityReset: true },
    { hostname: 'later', isIdentityReset: false },
  ]);
});

test('a failed identity reset stays pending until a boot reports it done', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.templates.createTemplate('dev', 'tools');

  ctx.fake.setIdentityReset('failed');

  await ctx.imps.createImp({ name: 'copy', image: 'tools' });

  const failed = await findImpByName(ctx.db, 'copy');

  expect(failed?.isIdentityResetPending).toBe(true);

  // a ping without the field reports nothing: still pending
  ctx.fake.setIdentityReset(undefined);

  await ctx.imps.stopImp('copy');
  await ctx.imps.startImp('copy');

  const unreported = await findImpByName(ctx.db, 'copy');

  expect(unreported?.isIdentityResetPending).toBe(true);

  ctx.fake.setIdentityReset('ok');

  await ctx.imps.stopImp('copy');
  await ctx.imps.startImp('copy');

  const done = await findImpByName(ctx.db, 'copy');

  expect(done?.isIdentityResetPending).toBe(false);
});

test('a clone that fails while frozen still thaws and leaves no image', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev', image: 'base' });

  ctx.events.length = 0;
  ctx.state.failClone = true;

  const failure = await ctx.templates
    .createTemplate('dev', 'tools')
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ message: 'clone failed' });
  expect(ctx.events).toEqual(['freeze', 'thaw']);

  const tools = await findImageByName(ctx.db, 'tools');

  expect(tools).toBeUndefined();
  expect(readdirSync(join(ctx.dataDir, 'images')).toSorted()).toEqual(['base']);
});
