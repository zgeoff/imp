import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { createDiskBudget } from '../storage/disk-budget';
import type { TemplateBuildPlan } from '../vmm/template-vm';
import { buildTemplateKey, createBootTemplates } from './boot-templates';
import type { BootTemplateDeps } from './boot-templates';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'boot-templates-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const builds: TemplateBuildPlan[] = [];
  const admitted: string[] = [];
  const logs: string[] = [];

  // the taps and cgroups each build asked for, in order
  const cgroupCalls: string[] = [];

  // the disk room held while each build ran
  const pendingAtBuild: number[] = [];

  // a frozen clock, far from the wall clock, that moves only with advance
  const clock = { ms: Date.UTC(2026, 0, 1) };

  // the host's free space, so a build never meets this machine's disk
  const diskBudget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }) },
    reserveBytes: null,
    log: () => {},
  });

  const deps: BootTemplateDeps = {
    dataDir,
    identity: {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: 'k',
      systemDrive: 'd1',
      systemDrivePath: join(dataDir, 'system', 'drives', 'd1'),
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
    },
    firecrackerBin: 'firecracker',
    kernelPath: 'vmlinux',
    minGuestUptimeMs: 1500,
    bootReservePercent: 50,

    // the template VM: it writes the snapshot's two files
    buildVm: async (plan) => {
      builds.push(plan);

      const status = await diskBudget.readStatus();

      pendingAtBuild.push(status.pendingBytes);

      mkdirSync(plan.snapshotDir, { recursive: true });
      writeFileSync(plan.vmstate, 'vmstate');
      writeFileSync(plan.memFile, 'mem');
    },
    taps: {
      setupTap: (address, owner) => {
        cgroupCalls.push(`tap ${address.tap} ${String(owner?.uid ?? 'root')}`);

        return Promise.resolve();
      },
      removeTap: () => Promise.resolve(),
    },
    jail: null,
    cgroups: {
      setup: (impId, _cpu, memoryMib) => {
        cgroupCalls.push(`setup ${impId} ${String(memoryMib)}`);

        return {
          procsPath: `/cg/${impId}/cgroup.procs`,
          liftLimit: () => {},
          applyLimit: () => {},
        };
      },
      remove: (impId) => {
        cgroupCalls.push(`remove ${impId}`);

        return Promise.resolve();
      },
    },
    admission: {
      admit: (request) => {
        admitted.push(
          `${request.id} ${String(request.reserveMib)} ${String(request.maySleepImps ?? true)}`,
        );

        return Promise.resolve();
      },
      release: (id) => {
        admitted.push(`release ${id}`);
      },
    },
    diskBudget,
    now: () => clock.ms,
    log: (message) => {
      logs.push(message);
    },
  };

  return {
    dataDir,
    deps,
    diskBudget,
    builds,
    admitted,
    logs,
    cgroupCalls,
    pendingAtBuild,
    advance: (ms: number) => {
      clock.ms += ms;
    },
  };
}

test('#buildTemplateKey changes with each thing a restore inherits', () => {
  const identity = {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: 'd1',
    systemDrivePath: '/data/system/drives/d1',
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  };

  const shape = { vcpus: 1, memoryMib: 512 };

  const keys = [
    buildTemplateKey(identity, shape),
    buildTemplateKey({ ...identity, guestKernel: 'k2' }, shape),
    buildTemplateKey({ ...identity, systemDrive: 'd2' }, shape),
    buildTemplateKey({ ...identity, firecrackerVersion: 'v1.18.0' }, shape),
    buildTemplateKey({ ...identity, snapshotVersion: 'v13.0.0' }, shape),
    buildTemplateKey({ ...identity, hostKernel: 'other' }, shape),
    buildTemplateKey({ ...identity, cpuModel: 'Other CPU' }, shape),
    buildTemplateKey({ ...identity, cpuFlags: 'other-flags' }, shape),
    buildTemplateKey(identity, { ...shape, vcpus: 2 }),
    buildTemplateKey(identity, { ...shape, memoryMib: 1024 }),
  ];

  expect(new Set(keys).size).toBe(keys.length);
});

test('#buildTemplateKey keeps the key when only the drive path changes', () => {
  const identity = {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: 'd1',
    systemDrivePath: '/data/system/drives/d1',
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  };

  const shape = { vcpus: 1, memoryMib: 512 };

  expect(buildTemplateKey({ ...identity, systemDrivePath: '/elsewhere' }, shape)).toBe(
    buildTemplateKey(identity, shape),
  );
});

test('#find answers null and starts no build on the first miss of a shape', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);
  const found = store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(found).toBeNull();
  expect(ctx.builds).toStrictEqual([]);
});

test('#find starts one build on the second miss of a shape, shared by the misses after it', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(ctx.builds).toHaveLength(1);
});

test('#find answers the template a build made', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.find({ vcpus: 1, memoryMib: 512 })).toStrictEqual(files);
});

test('#buildTemplate names the template by its key', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(files.key).toBe(buildTemplateKey(ctx.deps.identity, { vcpus: 1, memoryMib: 512 }));
});

test('#buildTemplate takes free RAM only, for half its memory, and gives it back', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.admitted).toStrictEqual([
    `template-${files.key.slice(0, 12)} 256 false`,
    `release template-${files.key.slice(0, 12)}`,
  ]);
});

test('#buildTemplate holds disk room for its whole memory through the build only', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const after = await ctx.diskBudget.readStatus();

  expect(ctx.pendingAtBuild).toStrictEqual([512 * 1024 ** 2]);
  expect(after.pendingBytes).toBe(0);
});

test('#buildTemplate leaves only the template and the placeholder disk', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(readdirSync(join(ctx.dataDir, 'templates'))).toIncludeSameMembers([
    'placeholder.ext4',
    files.key,
  ]);
});

test('#buildTemplate names the same placeholder disk in every build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });
  await store.buildTemplate({ vcpus: 1, memoryMib: 1024 });

  expect(ctx.builds.map((plan) => plan.placeholderPath)).toStrictEqual([
    join(ctx.dataDir, 'templates', 'placeholder.ext4'),
    join(ctx.dataDir, 'templates', 'placeholder.ext4'),
  ]);
});

test('#buildTemplate boots a parked agent with no imp address', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const [plan] = ctx.builds;

  invariant(plan);

  const args = plan.bootArgs.split(' ');

  expect(args).toContain('imp.template=1');
  expect(args.filter((arg) => arg.startsWith('imp.ip'))).toStrictEqual([]);
});

test('#buildTemplate runs a jailed build as the build uid in a cgroup of its own', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({ ...ctx.deps, jail: { uid: 899_999, gid: 899_999 } });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const [plan] = ctx.builds;

  invariant(plan);

  expect(plan).toMatchObject({
    jailId: 'tpl-build',
    jail: { uid: 899_999, gid: 899_999 },
    cgroup: { procsPath: '/cg/tpl-build/cgroup.procs' },
    workDir: expect.stringContaining(join(ctx.dataDir, 'templates', '.build-')) as unknown,
    paths: { runDir: join(plan.workDir, 'run') },
  });
});

test('#buildTemplate gives a jailed build its tap and a cgroup sized to it, removed after', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({ ...ctx.deps, jail: { uid: 899_999, gid: 899_999 } });

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(ctx.cgroupCalls).toStrictEqual([
    'tap imp-tpl 899999',
    'setup tpl-build 512',
    'remove tpl-build',
  ]);
});

// a restore reopens the drive the snapshot booted, and the placeholder
test('#buildTemplate returns the drive and the placeholder a restore reopens', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(files).toMatchObject({
    systemDrivePath: ctx.deps.identity.systemDrivePath,
    placeholderPath: join(ctx.dataDir, 'templates', 'placeholder.ext4'),
  });
});

test('#buildTemplate refuses a jailed build without its cgroup before any VM starts', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    jail: { uid: 899_999, gid: 899_999 },
    cgroups: { setup: () => null, remove: () => Promise.resolve() },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'a jailed template build needs its own cgroup, and it has none',
  );

  expect(ctx.builds).toStrictEqual([]);
});

test('#buildTemplate leaves no template behind a failed build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    buildVm: () => Promise.reject(new Error('no agent')),
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no agent');
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toStrictEqual(['placeholder.ext4']);
});

test('#find starts no build while a failed build backs off', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    buildVm: (plan) => {
      ctx.builds.push(plan);

      return Promise.reject(new Error('no agent'));
    },
  });

  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(ctx.builds).toHaveLength(1);
});

test('#buildTemplate refuses a shape while its failed build backs off', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
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

  const store = createBootTemplates({
    ...ctx.deps,
    buildVm: (plan) => {
      ctx.builds.push(plan);

      return Promise.reject(new Error('no agent'));
    },
  });

  store.find({ vcpus: 1, memoryMib: 512 });
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  ctx.advance(60_000);
  store.find({ vcpus: 1, memoryMib: 512 });

  await store.stop();

  expect(ctx.builds).toHaveLength(2);
});

test('#buildTemplate turns a key off at its third failed build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
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

  const store = createBootTemplates({
    ...ctx.deps,
    buildVm: (plan) => {
      ctx.builds.push(plan);

      return Promise.reject(new Error('no agent'));
    },
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

  expect(ctx.builds).toHaveLength(3);
});

test('#buildTemplate refuses a build the RAM turns away with the admission error', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
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
    diskBudget: createDiskBudget({
      storage: { readUsage: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 3 }) },
      reserveBytes: null,
      log: () => {},
    }),
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(building).rejects.toThrow('not enough free disk');
});

test('#buildTemplate backs off a minute after a refused build', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates({
    ...ctx.deps,
    admission: { admit: () => Promise.reject(new Error('no room: ram')), release: () => {} },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no room: ram');
  expect(ctx.logs.at(-1)).toInclude('build refused (next try in 60s): no room: ram');
});

test('#buildTemplate gives back the admission of a refused build and leaves no work directory', async () => {
  const ctx = await setupTest();

  const released: string[] = [];

  const store = createBootTemplates({
    ...ctx.deps,
    admission: {
      admit: () => Promise.reject(new Error('no room: ram')),
      release: (id) => {
        released.push(id);
      },
    },
  });

  const building = store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'no room: ram');
  expect(released).toHaveLength(1);
  expect(existsSync(join(ctx.dataDir, 'templates'))).toBeFalse();
});

test('#buildTemplate counts no refused build as a failure', async () => {
  const ctx = await setupTest();

  const room = { isRefused: true };

  const store = createBootTemplates({
    ...ctx.deps,
    admission: {
      admit: () => (room.isRefused ? Promise.reject(new Error('no room: ram')) : Promise.resolve()),
      release: () => {},
    },
  });

  for (let count = 0; count < 4; count += 1) {
    await store.buildTemplate({ vcpus: 1, memoryMib: 512 }).catch(() => null);

    ctx.advance(60_000);
  }

  room.isRefused = false;

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(existsSync(files.memFile)).toBeTrue();
});

test('#reportFailure keeps a template whose restore failed in the imp', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(files, false);

  expect(existsSync(files.memFile)).toBeTrue();
});

test('#reportFailure removes a template whose restore failed in the template', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  const files = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(files, true);

  expect(existsSync(files.memFile)).toBeFalse();
});

test('#reportFailure for an older build leaves the rebuilt template', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  const first = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(first, true);

  const rebuilt = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.reportFailure(first, true);

  expect(existsSync(rebuilt.memFile)).toBeTrue();
});

test('#reportFailure turns a key off at its third template fault in a row', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

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

  const store = createBootTemplates(ctx.deps);

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

  const store = createBootTemplates(ctx.deps);

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

  const store = createBootTemplates(ctx.deps);

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

  const store = createBootTemplates(ctx.deps);

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

  const store = createBootTemplates(ctx.deps);

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

  const store = createBootTemplates(ctx.deps);

  // a template the host built before its system drive changed
  const old = createBootTemplates({
    ...ctx.deps,
    identity: {
      ...ctx.deps.identity,
      systemDrive: 'd0',
      systemDrivePath: join(ctx.dataDir, 'system', 'drives', 'd0'),
    },
  });

  const stale = await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.removeStale()).toStrictEqual([stale.key]);
});

test('#removeStale removes what a cut-short build left', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  mkdirSync(join(ctx.dataDir, 'templates', '.build-cut-short'));

  store.removeStale();

  expect(existsSync(join(ctx.dataDir, 'templates', '.build-cut-short'))).toBeFalse();
});

test('#removeStale never removes a current template or the placeholder disk', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  const current = await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: {
      ...ctx.deps.identity,
      systemDrive: 'd0',
      systemDrivePath: join(ctx.dataDir, 'system', 'drives', 'd0'),
    },
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

  const store = createBootTemplates(ctx.deps);

  expect(store.removeStale()).toStrictEqual([]);
});

test('#listDrivePaths lists the system drive of every template', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);
  const oldDrive = join(ctx.dataDir, 'system', 'drives', 'd0');

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: { ...ctx.deps.identity, systemDrive: 'd0', systemDrivePath: oldDrive },
  });

  await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  expect(store.listDrivePaths()).toIncludeSameMembers([
    ctx.deps.identity.systemDrivePath,
    oldDrive,
  ]);
});

test('#listDrivePaths drops the drive of a stale template once it is removed', async () => {
  const ctx = await setupTest();

  const store = createBootTemplates(ctx.deps);

  await store.buildTemplate({ vcpus: 1, memoryMib: 512 });

  const old = createBootTemplates({
    ...ctx.deps,
    identity: {
      ...ctx.deps.identity,
      systemDrive: 'd0',
      systemDrivePath: join(ctx.dataDir, 'system', 'drives', 'd0'),
    },
  });

  await old.buildTemplate({ vcpus: 1, memoryMib: 512 });

  store.removeStale();

  expect(store.listDrivePaths()).toStrictEqual([ctx.deps.identity.systemDrivePath]);
});
