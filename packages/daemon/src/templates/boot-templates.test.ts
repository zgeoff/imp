import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostIdentity } from '../sleep/vm-identity';
import type { TemplateBuildPlan } from '../vmm/template-vm';
import { buildTemplateKey, createBootTemplates } from './boot-templates';
import type { BootTemplateDeps } from './boot-templates';

const SHAPE = { vcpus: 1, memoryMib: 512 };

// the stand-in disk every template's snapshot names
const PLACEHOLDER = 'placeholder.ext4';

function buildIdentity(dataDir: string, drive: string): HostIdentity {
  return {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: drive,
    systemDrivePath: join(dataDir, 'system', 'drives', drive),
  };
}

// a store over a fresh data dir whose builds write two small files; `gate`
// holds each build until the test resolves it
function setupStore(overrides: Partial<BootTemplateDeps> = {}) {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-templates-`);
  const builds: TemplateBuildPlan[] = [];
  const admitted: string[] = [];
  const logs: string[] = [];
  const gate = { promise: Promise.resolve() };

  const deps: BootTemplateDeps = {
    dataDir,
    identity: buildIdentity(dataDir, 'd1'),
    firecrackerBin: 'firecracker',
    kernelPath: 'vmlinux',
    minGuestUptimeMs: 1500,
    bootReservePercent: 50,
    buildVm: async (plan) => {
      builds.push(plan);

      await gate.promise;

      mkdirSync(plan.snapshotDir, { recursive: true });
      writeFileSync(plan.vmstate, 'vmstate');
      writeFileSync(plan.memFile, 'mem');
    },
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    admission: {
      admit: (request) => {
        admitted.push(`${request.id} ${String(request.reserveMib)}`);

        return Promise.resolve();
      },
      release: (id) => {
        admitted.push(`release ${id}`);
      },
    },
    log: (message) => {
      logs.push(message);
    },
    ...overrides,
  };

  return {
    dataDir,
    deps,
    builds,
    admitted,
    logs,
    gate,
    store: createBootTemplates(deps),
    [Symbol.dispose]() {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('the key changes with each thing a restore inherits, and not with the drive path', () => {
  const identity = buildIdentity('/data', 'd1');
  const key = buildTemplateKey(identity, SHAPE);

  const changed = [
    buildTemplateKey({ ...identity, guestKernel: 'k2' }, SHAPE),
    buildTemplateKey({ ...identity, systemDrive: 'd2' }, SHAPE),
    buildTemplateKey({ ...identity, firecrackerVersion: 'v1.18.0' }, SHAPE),
    buildTemplateKey({ ...identity, snapshotVersion: 'v13.0.0' }, SHAPE),
    buildTemplateKey({ ...identity, hostKernel: 'other' }, SHAPE),
    buildTemplateKey(identity, { ...SHAPE, vcpus: 2 }),
    buildTemplateKey(identity, { ...SHAPE, memoryMib: 1024 }),
  ];

  expect(new Set([key, ...changed]).size).toBe(changed.length + 1);
  expect(buildTemplateKey({ ...identity, systemDrivePath: '/elsewhere' }, SHAPE)).toBe(key);
});

test('a miss builds in the background; misses of one key share the build', async () => {
  using ctx = setupStore();

  const held = Promise.withResolvers<void>();

  ctx.gate.promise = held.promise;

  expect(ctx.store.find(SHAPE)).toBeNull();
  expect(ctx.store.find(SHAPE)).toBeNull();

  const building = ctx.store.buildTemplate(SHAPE);

  held.resolve();

  const files = await building;

  const key = buildTemplateKey(ctx.deps.identity, SHAPE);

  expect(ctx.builds).toHaveLength(1);
  expect(ctx.store.find(SHAPE)).toEqual(files);
  expect(files.key).toBe(key);

  expect(ctx.admitted).toEqual([
    `template-${key.slice(0, 12)} 256`,
    `release template-${key.slice(0, 12)}`,
  ]);

  // the build's work directory is gone; only the template and the placeholder stay
  expect(readdirSync(join(ctx.dataDir, 'templates')).toSorted()).toEqual([key, PLACEHOLDER]);
});

test('every build names the same placeholder disk, which the snapshot records', async () => {
  using ctx = setupStore();

  await ctx.store.buildTemplate(SHAPE);
  await ctx.store.buildTemplate({ ...SHAPE, memoryMib: 1024 });

  const placeholders = new Set(ctx.builds.map((plan) => plan.placeholderPath));

  expect([...placeholders]).toEqual([join(ctx.dataDir, 'templates', 'placeholder.ext4')]);

  const parked = ctx.builds.map((plan) => plan.bootArgs.includes('imp.template=1'));

  expect(parked).toEqual([true, true]);
  expect(ctx.builds[0]?.bootArgs).not.toContain('imp.ip');
});

test('a failed build leaves nothing, and the next miss tries again', async () => {
  const failing = { isFailing: true };

  using ctx = setupStore({
    buildVm: (plan) => {
      if (failing.isFailing) {
        return Promise.reject(new Error('no agent'));
      }

      mkdirSync(plan.snapshotDir, { recursive: true });
      writeFileSync(plan.vmstate, 'vmstate');
      writeFileSync(plan.memFile, 'mem');

      return Promise.resolve();
    },
  });

  const failed = await ctx.store.buildTemplate(SHAPE).catch((error: unknown) => error);

  expect(failed).toBeInstanceOf(Error);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toEqual(['placeholder.ext4']);

  failing.isFailing = false;

  await ctx.store.buildTemplate(SHAPE);

  expect(ctx.store.find(SHAPE)).not.toBeNull();
});

test('a discarded template is built again on the next miss', async () => {
  using ctx = setupStore();

  const files = await ctx.store.buildTemplate(SHAPE);

  ctx.store.discard(files.key);

  expect(existsSync(files.memFile)).toBe(false);
  expect(ctx.store.find(SHAPE)).toBeNull();

  await ctx.store.stop();

  expect(ctx.builds).toHaveLength(2);
  expect(ctx.store.find(SHAPE)).toEqual(files);
});

test('removeStale drops templates of another host and what cut-short builds left', async () => {
  using ctx = setupStore();

  const current = await ctx.store.buildTemplate(SHAPE);

  // a template the host built before its system drive changed
  const old = createBootTemplates({ ...ctx.deps, identity: buildIdentity(ctx.dataDir, 'd0') });

  const stale = await old.buildTemplate(SHAPE);

  mkdirSync(join(ctx.dataDir, 'templates', '.build-cut-short'));

  expect(ctx.store.listDrivePaths().toSorted()).toEqual(
    [
      ctx.deps.identity.systemDrivePath,
      buildIdentity(ctx.dataDir, 'd0').systemDrivePath,
    ].toSorted(),
  );

  expect(ctx.store.removeStale()).toEqual([stale.key]);

  expect(readdirSync(join(ctx.dataDir, 'templates')).toSorted()).toEqual(
    [current.key, PLACEHOLDER].toSorted(),
  );

  expect(ctx.store.listDrivePaths()).toEqual([ctx.deps.identity.systemDrivePath]);
});
