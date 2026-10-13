import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { readAgentFixture } from '@imp/test-utils/read-agent-fixture';
import * as z from 'zod';
import { createDiskBudget } from '../storage/disk-budget';
import { buildMockHostIdentity } from '../test-utils/build-mock-host-identity';
import { buildStubTemplateVm } from '../test-utils/build-stub-template-vm';
import { TEMPLATE_BOOT_ARGS, buildTemplateKey, createBootTemplates } from './boot-templates';
import type { BootTemplateDeps } from './boot-templates';

// a template store's host: a data dir, the template VM, a disk budget, the
// taps, cgroups and RAM admission as recorders, and a frozen clock
async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'boot-templates-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const logs: string[] = [];

  // a frozen clock, far from the wall clock, that moves only with advance
  const clock = { ms: Date.UTC(2026, 0, 1) };

  // the host's free space, so a build never meets this machine's disk
  const diskBudget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }) },
    reserveBytes: null,
    log: () => {},
  });

  const vm = buildStubTemplateVm(diskBudget);

  const deps = {
    dataDir,

    // the binary, kernel and guest age only the template VM reads
    firecrackerBin: 'firecracker',
    kernelPath: 'vmlinux',
    minGuestUptimeMs: 1500,
    buildVm: vm.buildVm,
    taps: { setupTap: mock(() => Promise.resolve()), removeTap: mock(() => Promise.resolve()) },
    jail: null,
    cgroups: {
      setup: mock((impId: string) => ({
        procsPath: `/cg/${impId}/cgroup.procs`,
        liftLimit: () => {},
        applyLimit: () => {},
      })),
      remove: mock(() => Promise.resolve()),
    },
    admission: { admit: mock(() => Promise.resolve()), release: mock(() => {}) },
    diskBudget,
    now: () => clock.ms,
    log: (message: string) => {
      logs.push(message);
    },
  } satisfies Omit<BootTemplateDeps, 'identity' | 'bootReservePercent'>;

  return {
    dataDir,
    deps,
    diskBudget,
    vm,
    logs,
    advance: (ms: number) => {
      clock.ms += ms;
    },
  };
}

test('#TEMPLATE_BOOT_ARGS is the cmdline the agent reads as a template (agent/internal/contract)', () => {
  expect(TEMPLATE_BOOT_ARGS).toBe(
    z.object({ template_boot_args: z.string() }).parse(readAgentFixture('host/cmdline.json'))
      .template_boot_args,
  );
});

test('#buildTemplateKey changes with each thing a restore inherits', () => {
  const identity = buildMockHostIdentity();
  const shape = { vcpus: 1, memoryMib: 512 };

  const keys = [
    buildTemplateKey(identity, shape),
    buildTemplateKey({ ...identity, guestKernel: `${identity.guestKernel}-other` }, shape),
    buildTemplateKey({ ...identity, systemDrive: `${identity.systemDrive}-other` }, shape),
    buildTemplateKey(
      { ...identity, firecrackerVersion: `${identity.firecrackerVersion}-other` },
      shape,
    ),
    buildTemplateKey({ ...identity, snapshotVersion: `${identity.snapshotVersion}-other` }, shape),
    buildTemplateKey({ ...identity, hostKernel: `${identity.hostKernel}-other` }, shape),
    buildTemplateKey({ ...identity, cpuModel: `${identity.cpuModel}-other` }, shape),
    buildTemplateKey({ ...identity, cpuFlags: `${identity.cpuFlags}-other` }, shape),
    buildTemplateKey(identity, { ...shape, vcpus: 2 }),
    buildTemplateKey(identity, { ...shape, memoryMib: 1024 }),
  ];

  expect(new Set(keys).size).toBe(keys.length);
});

test('#buildTemplateKey keeps the key when only the drive path changes', () => {
  const identity = buildMockHostIdentity();
  const shape = { vcpus: 1, memoryMib: 512 };

  expect(buildTemplateKey({ ...identity, systemDrivePath: '/elsewhere' }, shape)).toBe(
    buildTemplateKey(identity, shape),
  );
});

test('#find answers null and starts no build on the first miss of a shape', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const found = store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(found).toBeNull();
  expect(ctx.vm.builds).toStrictEqual([]);
});

test('#find starts one build on the second miss of a shape, shared by the misses after it', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(ctx.vm.builds).toHaveLength(1);
});

test('#find answers the template a build made', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.find({ vcpus: 1, memoryMib: 512 })).toStrictEqual(files);
});

test('#buildTemplate names the template by its key', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(files.key).toBe(buildTemplateKey(identity, { vcpus: 1, memoryMib: 512 }));
});

test('#buildTemplate takes free RAM only, for its boot reserve of its memory', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.admission.admit).toHaveBeenCalledExactlyOnceWith({
    id: `template-${files.key.slice(0, 12)}`,
    name: null,
    reserveMib: 256,
    memoryMib: 512,
    maySleepImps: false,
  });
});

test('#buildTemplate gives back the RAM it took once the build is done', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.admission.release).toHaveBeenCalledExactlyOnceWith(
    `template-${files.key.slice(0, 12)}`,
  );

  expect(ctx.deps.admission.release).toHaveBeenCalledAfter(ctx.deps.admission.admit);
});

test('#buildTemplate holds disk room for its whole memory through the build only', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const after = await ctx.diskBudget.readStatus();

  expect(ctx.vm.pendingAtBuild).toStrictEqual([512 * 1024 ** 2]);
  expect(after.pendingBytes).toBe(0);
});

test('#buildTemplate leaves only the template and the placeholder disk', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(readdirSync(join(ctx.dataDir, 'templates'))).toIncludeSameMembers([
    'placeholder.ext4',
    files.key,
  ]);
});

test('#buildTemplate names the same placeholder disk in every build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });
  await store.buildTemplate({ vcpus: 1, memoryMib: 1024 });

  expect(ctx.vm.builds.map((plan) => plan.placeholderPath)).toStrictEqual([
    join(ctx.dataDir, 'templates', 'placeholder.ext4'),
    join(ctx.dataDir, 'templates', 'placeholder.ext4'),
  ]);
});

test('#buildTemplate boots a parked agent with no imp address', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const [plan] = ctx.vm.builds;

  invariant(plan);

  const args = plan.bootArgs.split(' ');

  expect(args).toContain('imp.template=1');
  expect(args.filter((arg) => arg.startsWith('imp.ip'))).toStrictEqual([]);
});

test('#buildTemplate runs a jailed build as the build uid in a cgroup of its own', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const [plan] = ctx.vm.builds;

  invariant(plan);

  expect(plan).toMatchObject({
    jailId: 'tpl-build',
    jail: { uid: 899_999, gid: 899_999 },
    cgroup: { procsPath: '/cg/tpl-build/cgroup.procs' },
    workDir: expect.stringContaining(join(ctx.dataDir, 'templates', '.build-')) as unknown,
    paths: { runDir: join(plan.workDir, 'run') },
  });
});

test('#buildTemplate gives a jailed build its tap, owned by the build uid', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.taps.setupTap).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tap: 'imp-tpl' }),
    { uid: 899_999, gid: 899_999 },
  );
});

test('#buildTemplate sizes the cgroup of a jailed build to its memory after its tap', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.cgroups.setup).toHaveBeenCalledExactlyOnceWith(
    'tpl-build',
    expect.anything(),
    512,
  );

  expect(ctx.deps.cgroups.setup).toHaveBeenCalledAfter(ctx.deps.taps.setupTap);
});

test('#buildTemplate removes the cgroup of a jailed build once the build is done', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.deps.cgroups.remove).toHaveBeenCalledExactlyOnceWith('tpl-build');
  expect(ctx.deps.cgroups.remove).toHaveBeenCalledAfter(ctx.deps.cgroups.setup);
});

// a restore reopens the drive the snapshot booted, and the placeholder
test('#buildTemplate returns the drive and the placeholder a restore reopens', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(files).toMatchObject({
    systemDrivePath: identity.systemDrivePath,
    placeholderPath: join(ctx.dataDir, 'templates', 'placeholder.ext4'),
  });
});

test('#buildTemplate refuses a jailed build without its cgroup before any VM starts', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    jail: { uid: 899_999, gid: 899_999 },
    cgroups: { setup: () => null, remove: () => Promise.resolve() },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'a jailed template build needs its own cgroup, and it has none',
  );

  expect(ctx.vm.builds).toStrictEqual([]);
});

test('#buildTemplate leaves no template behind a failed build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm: () => Promise.reject(new Error('no agent')),
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no agent');
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toStrictEqual(['placeholder.ext4']);
});

test('#find starts no build while a failed build backs off', async () => {
  const ctx = await setupTest();

  const buildVm = mock(() => Promise.reject(new Error('no agent')));

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm,
  });

  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(buildVm).toHaveBeenCalledOnce();
});

test('#buildTemplate refuses a shape while its failed build backs off', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm: () => Promise.reject(new Error('no agent')),
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'boot template builds of this shape back off; try again later',
  );
});

test('#find builds again once the backoff after a failed build has passed', async () => {
  const ctx = await setupTest();

  const buildVm = mock(() => Promise.reject(new Error('no agent')));

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm,
  });

  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  ctx.advance(60_000);
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(buildVm).toHaveBeenCalledTimes(2);
});

test('#buildTemplate turns a key off at its third failed build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm: () => Promise.reject(new Error('no agent')),
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(60_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(120_000);

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no agent');
  expect(ctx.logs.at(-1)).toInclude('build failed (off until impd restarts): no agent');
});

test('#buildTemplate refuses a key that is off however long it waits', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm: () => Promise.reject(new Error('no agent')),
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(60_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(120_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(3_600_000);

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'boot templates of this shape are off until impd restarts',
  );
});

test('#find starts no build for a key that is off', async () => {
  const ctx = await setupTest();

  const buildVm = mock(() => Promise.reject(new Error('no agent')));

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    buildVm,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(60_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(120_000);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

  ctx.advance(3_600_000);
  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(buildVm).toHaveBeenCalledTimes(3);
});

test('#buildTemplate refuses a build the RAM turns away with the admission error', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    admission: { admit: () => Promise.reject(new Error('no room: ram')), release: () => {} },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(Error, 'no room: ram');
});

test('#buildTemplate refuses a build the disk has no room for', async () => {
  const ctx = await setupTest();

  // a disk of 1 GiB holds no 512 MiB build past its reserve
  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    diskBudget: createDiskBudget({
      storage: { readUsage: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 3 }) },
      reserveBytes: null,
      log: () => {},
    }),
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    /^not enough free disk: 1\.0 GiB free, 0\.5 GiB wanted, /,
  );
});

test('#buildTemplate backs off a minute after a refused build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    admission: { admit: () => Promise.reject(new Error('no room: ram')), release: () => {} },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no room: ram');
  expect(ctx.logs.at(-1)).toInclude('build refused (next try in 60s): no room: ram');
});

test('#buildTemplate gives back the admission of a refused build and leaves no work directory', async () => {
  const ctx = await setupTest();

  const release = mock(() => {});

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    admission: { admit: () => Promise.reject(new Error('no room: ram')), release },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no room: ram');
  expect(release).toHaveBeenCalledOnce();
  expect(existsSync(join(ctx.dataDir, 'templates'))).toBeFalse();
});

test('#buildTemplate counts no refused build as a failure', async () => {
  const ctx = await setupTest();

  // four refusals, past the three failures that turn a key off, then room
  const admit = mock(() => Promise.resolve())
    .mockImplementationOnce(() => Promise.reject(new Error('no room: ram')))
    .mockImplementationOnce(() => Promise.reject(new Error('no room: ram')))
    .mockImplementationOnce(() => Promise.reject(new Error('no room: ram')))
    .mockImplementationOnce(() => Promise.reject(new Error('no room: ram')));

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
    admission: { admit, release: () => {} },
  });

  for (let count = 0; count < 4; count += 1) {
    await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

    ctx.advance(60_000);
  }

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(existsSync(files.memFile)).toBeTrue();
});

test('#reportFailure keeps a template whose restore failed in the imp', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(files, false);

  expect(existsSync(files.memFile)).toBeTrue();
});

test('#reportFailure removes a template whose restore failed in the template', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(files, true);

  expect(existsSync(files.memFile)).toBeFalse();
});

test('#reportFailure for an older build leaves the rebuilt template', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  const first = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(first, true);

  const rebuilt = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(first, true);

  expect(existsSync(rebuilt.memFile)).toBeTrue();
});

test('#reportFailure turns a key off at its third template fault in a row', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 2; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    store.reportFailure(files, true);
  }

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(files, true);

  expect(ctx.logs.at(-1)).toInclude('off until impd restarts: 3 restores failed');
});

test('#buildTemplate refuses a key its restore faults turned off', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 3; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    store.reportFailure(files, true);
  }

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'boot templates of this shape are off until impd restarts',
  );
});

// an image that never pings fails in the imp, every time
test('#reportFailure counts no fault in the imp toward turning the key off', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 2; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    store.reportFailure(files, true);
  }

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  for (let count = 0; count < 5; count += 1) {
    store.reportFailure(files, false);
  }

  expect(store.find({ vcpus: 1, memoryMib: 512 })).toStrictEqual(files);
});

test('#reportRestored starts the count of template faults again', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 2; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    store.reportFailure(files, true);
  }

  const restored = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportRestored(restored);
  store.reportFailure(restored, true);

  const rebuilt = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(rebuilt, true);

  expect(ctx.logs.join('\n')).not.toInclude('restores failed');
});

test('#reportFailure counts no failure for a template evicted before it', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (let count = 0; count < 3; count += 1) {
    const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

    rmSync(join(ctx.dataDir, 'templates', files.key), { recursive: true });

    store.reportFailure(files, true);
  }

  const rebuilt = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.find({ vcpus: 1, memoryMib: 512 })).toStrictEqual(rebuilt);
});

test('#buildTemplate removes the least recently used template past four', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  for (const memoryMib of [256, 512, 768, 1024]) {
    await store.buildTemplate({ vcpus: 1, memoryMib });

    ctx.advance(1000);
  }

  // the first is used again; the second is now the oldest
  store.find({ vcpus: 1, memoryMib: 256 });
  ctx.advance(1000);

  await store.buildTemplate({ vcpus: 2, memoryMib: 256 });

  expect(store.find({ vcpus: 1, memoryMib: 512 })).toBeNull();
  expect(store.find({ vcpus: 1, memoryMib: 256 })).not.toBeNull();
  expect(store.find({ vcpus: 1, memoryMib: 768 })).not.toBeNull();
  expect(store.find({ vcpus: 1, memoryMib: 1024 })).not.toBeNull();
});

test('#removeStale removes the templates of another host identity', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  // a template the host built before its system drive changed
  const old = createBootTemplates({
    ...ctx.deps,
    identity: { ...identity, systemDrive: 'd0', systemDrivePath: '/data/system/drives/d0' },
    bootReservePercent: 50,
  });

  const stale = await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.removeStale()).toStrictEqual([stale.key]);
});

test('#removeStale removes what a cut-short build left', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  mkdirSync(join(ctx.dataDir, 'templates', '.build-cut-short'));

  store.removeStale();

  expect(existsSync(join(ctx.dataDir, 'templates', '.build-cut-short'))).toBeFalse();
});

test('#removeStale never removes a current template or the placeholder disk', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity();
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  const current = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: { ...identity, systemDrive: 'd0', systemDrivePath: '/data/system/drives/d0' },
    bootReservePercent: 50,
  });

  await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.removeStale();

  expect(readdirSync(join(ctx.dataDir, 'templates'))).toIncludeSameMembers([
    'placeholder.ext4',
    current.key,
  ]);
});

test('#removeStale answers no keys before any template exists', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    identity: buildMockHostIdentity(),
    bootReservePercent: 50,
  });

  expect(store.removeStale()).toStrictEqual([]);
});

test('#listDrivePaths lists the system drive of every template', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity({ systemDrivePath: '/data/system/drives/d1' });
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: { ...identity, systemDrive: 'd0', systemDrivePath: '/data/system/drives/d0' },
    bootReservePercent: 50,
  });

  await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.listDrivePaths()).toIncludeSameMembers([
    '/data/system/drives/d1',
    '/data/system/drives/d0',
  ]);
});

test('#listDrivePaths drops the drive of a stale template once it is removed', async () => {
  const ctx = await setupTest();

  const identity = buildMockHostIdentity({ systemDrivePath: '/data/system/drives/d1' });
  const store = createBootTemplates({ ...ctx.deps, identity, bootReservePercent: 50 });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: { ...identity, systemDrive: 'd0', systemDrivePath: '/data/system/drives/d0' },
    bootReservePercent: 50,
  });

  await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.removeStale();

  expect(store.listDrivePaths()).toStrictEqual(['/data/system/drives/d1']);
});
