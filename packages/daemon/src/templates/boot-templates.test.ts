import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readErrorMessage } from '../read-error-message';
import { readRejection } from '../read-rejection';
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
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
  };
}

// a store over a fresh data dir whose builds write two small files; `gate`
// holds each build until the test resolves it
function setupStore(overrides: Partial<BootTemplateDeps> = {}) {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-templates-`);
  const builds: TemplateBuildPlan[] = [];
  const admitted: string[] = [];
  const logs: string[] = [];
  const roomAsked: number[] = [];

  // the disk room each build ran in, at the time it ran
  const roomHeld = { bytes: 0, atBuild: [] as number[] };
  const gate = { promise: Promise.resolve() };

  // `fail` makes every build fail until a test sets it back
  const failing = { isFailing: false };
  const clock = { ms: 1_000_000 };

  // what the build asked of the taps and cgroups, and whether it gets one
  const cgroupCalls: string[] = [];
  const cgroupState = { isUp: true };

  const deps: BootTemplateDeps = {
    dataDir,
    identity: buildIdentity(dataDir, 'd1'),
    firecrackerBin: 'firecracker',
    kernelPath: 'vmlinux',
    minGuestUptimeMs: 1500,
    bootReservePercent: 50,
    buildVm: async (plan) => {
      builds.push(plan);
      roomHeld.atBuild.push(roomHeld.bytes);

      await gate.promise;

      if (failing.isFailing) {
        throw new Error('no agent');
      }

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

        return cgroupState.isUp
          ? { procsPath: `/cg/${impId}/cgroup.procs`, liftLimit: () => {}, applyLimit: () => {} }
          : null;
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
    diskBudget: {
      withRoom: async (bytes, task) => {
        roomAsked.push(bytes);

        roomHeld.bytes += bytes;

        try {
          return await task();
        } finally {
          roomHeld.bytes -= bytes;
        }
      },
    },
    now: () => clock.ms,
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
    roomAsked,
    roomHeld,
    gate,
    failing,
    clock,
    cgroupCalls,
    cgroupState,
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
    buildTemplateKey({ ...identity, cpuModel: 'Other CPU' }, SHAPE),
    buildTemplateKey({ ...identity, cpuFlags: 'other-flags' }, SHAPE),
    buildTemplateKey(identity, { ...SHAPE, vcpus: 2 }),
    buildTemplateKey(identity, { ...SHAPE, memoryMib: 1024 }),
  ];

  expect(new Set([key, ...changed]).size).toBe(changed.length + 1);
  expect(buildTemplateKey({ ...identity, systemDrivePath: '/elsewhere' }, SHAPE)).toBe(key);
});

test('a shape builds on its second miss; misses of one key share the build', async () => {
  using ctx = setupStore();

  const held = Promise.withResolvers<void>();

  ctx.gate.promise = held.promise;

  expect(ctx.store.find(SHAPE)).toBeNull();
  expect(ctx.builds).toHaveLength(0);
  expect(ctx.store.find(SHAPE)).toBeNull();
  expect(ctx.store.find(SHAPE)).toBeNull();

  const building = ctx.store.buildTemplate(SHAPE);

  held.resolve();

  const files = await building;

  const key = buildTemplateKey(ctx.deps.identity, SHAPE);

  expect(ctx.builds).toHaveLength(1);
  expect(ctx.store.find(SHAPE)).toEqual(files);
  expect(files.key).toBe(key);

  // free RAM only, and room on the disk for the whole memory
  expect(ctx.admitted).toEqual([
    `template-${key.slice(0, 12)} 256 false`,
    `release template-${key.slice(0, 12)}`,
  ]);

  // held through the build, and given back after it
  expect(ctx.roomAsked).toEqual([512 * 1024 * 1024]);
  expect(ctx.roomHeld).toEqual({ bytes: 0, atBuild: [512 * 1024 * 1024] });

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

test('a jailed build runs as the build uid, owns its tap, and has a cgroup sized to it', async () => {
  using ctx = setupStore({ jail: { uid: 899_999, gid: 899_999 } });

  const files = await ctx.store.buildTemplate(SHAPE);

  const [plan] = ctx.builds;

  expect(plan).toMatchObject({
    jailId: 'tpl-build',
    jail: { uid: 899_999, gid: 899_999 },
    cgroup: { procsPath: '/cg/tpl-build/cgroup.procs' },
  });

  expect(plan?.workDir).toContain('.build-');
  expect(plan?.paths.runDir).toBe(join(plan?.workDir ?? '', 'run'));

  expect(ctx.cgroupCalls).toEqual([
    'tap imp-tpl 899999',
    'setup tpl-build 512',
    'remove tpl-build',
  ]);

  // a restore reopens the drive the snapshot booted, and the placeholder
  expect(files).toMatchObject({
    systemDrivePath: ctx.deps.identity.systemDrivePath,
    placeholderPath: join(ctx.dataDir, 'templates', PLACEHOLDER),
  });
});

test('a jailed build without its cgroup fails before any VM starts', async () => {
  using ctx = setupStore({ jail: { uid: 899_999, gid: 899_999 } });

  ctx.cgroupState.isUp = false;

  const refusal = await readRejection(ctx.store.buildTemplate(SHAPE));

  expect(readErrorMessage(refusal)).toContain('needs its own cgroup');
  expect(ctx.builds).toEqual([]);
});

test('a failing build backs off, and its third failure turns the key off', async () => {
  using ctx = setupStore();

  ctx.failing.isFailing = true;

  // each round: misses past the threshold, then the build they started
  const runTwoMisses = async () => {
    ctx.store.find(SHAPE);
    ctx.store.find(SHAPE);

    await ctx.store.stop();
  };

  await runTwoMisses();

  expect(ctx.builds).toHaveLength(1);
  expect(readdirSync(join(ctx.dataDir, 'templates'))).toEqual([PLACEHOLDER]);

  // within the backoff, misses start nothing, and nor does a direct build
  await runTwoMisses();

  expect(ctx.builds).toHaveLength(1);

  const heldOff = await ctx.store.buildTemplate(SHAPE).catch((error: unknown) => error);

  expect(String(heldOff)).toContain('back off');

  ctx.clock.ms += 60_000;

  await runTwoMisses();

  expect(ctx.builds).toHaveLength(2);

  ctx.clock.ms += 120_000;

  await runTwoMisses();

  expect(ctx.builds).toHaveLength(3);
  expect(ctx.logs.at(-1)).toContain('off until impd restarts');

  // off: no build, however long it waits
  ctx.failing.isFailing = false;
  ctx.clock.ms += 3_600_000;

  await runTwoMisses();

  expect(ctx.builds).toHaveLength(3);

  const turnedOff = await ctx.store.buildTemplate(SHAPE).catch((error: unknown) => error);

  expect(String(turnedOff)).toContain('off until impd restarts');
});

test('a build the RAM or the disk turns away backs off, but never counts as a failure', async () => {
  const refusal = { by: 'ram' };
  const released: string[] = [];

  const readRoom = (by: string) =>
    refusal.by === by ? Promise.reject(new Error(`no room: ${by}`)) : Promise.resolve();

  using refused = setupStore({
    admission: {
      admit: () => readRoom('ram'),
      release: (id) => {
        released.push(id);
      },
    },
    diskBudget: {
      withRoom: async (_bytes, task) => {
        await readRoom('disk');

        return task();
      },
    },
  });

  for (const by of ['ram', 'disk', 'ram', 'disk']) {
    refusal.by = by;

    const rejection = await refused.store.buildTemplate(SHAPE).catch((error: unknown) => error);

    expect(String(rejection)).toContain(`no room: ${by}`);

    refused.clock.ms += 60_000;
  }

  expect(refused.logs.at(-1)).toContain('build refused (next try in 60s): no room: disk');
  expect(refused.builds).toHaveLength(0);

  // the admission goes back each time, and no work directory stays
  expect(released).toHaveLength(4);
  expect(existsSync(join(refused.dataDir, 'templates'))).toBe(false);

  // four refusals, and the key still builds once there is room
  refusal.by = 'none';

  await refused.store.buildTemplate(SHAPE);

  expect(refused.store.find(SHAPE)).not.toBeNull();
});

test('a restore that fails in the template removes it; one that fails in the imp keeps it', async () => {
  using ctx = setupStore();

  const files = await ctx.store.buildTemplate(SHAPE);

  ctx.store.reportFailure(files, false);

  expect(existsSync(files.memFile)).toBe(true);

  ctx.store.reportFailure(files, true);

  expect(existsSync(files.memFile)).toBe(false);
});

test('a failure report for an older build leaves the rebuilt template', async () => {
  using ctx = setupStore();

  const first = await ctx.store.buildTemplate(SHAPE);

  ctx.store.reportFailure(first, true);

  const rebuilt = await ctx.store.buildTemplate(SHAPE);

  ctx.store.reportFailure(first, true);

  expect(rebuilt.buildId).not.toBe(first.buildId);
  expect(existsSync(rebuilt.memFile)).toBe(true);
});

test('three template faults in a row turn a key off; an imp fault does not count, a good restore resets', async () => {
  using ctx = setupStore();

  const runTemplateFault = async () => {
    const files = await ctx.store.buildTemplate(SHAPE);

    ctx.store.reportFailure(files, true);
  };

  await runTemplateFault();
  await runTemplateFault();

  const files = await ctx.store.buildTemplate(SHAPE);

  ctx.store.reportRestored(files);

  // an image that never pings fails in the imp, every time
  for (let count = 0; count < 5; count += 1) {
    ctx.store.reportFailure(files, false);
  }

  ctx.store.reportFailure(files, true);

  await runTemplateFault();

  expect(ctx.store.find(SHAPE)).toBeNull();
  expect(ctx.logs.at(-1)).not.toContain('off until impd restarts');

  await runTemplateFault();

  expect(ctx.logs.at(-1)).toContain('off until impd restarts: 3 restores failed');

  const offAfterFaults = await ctx.store.buildTemplate(SHAPE).catch((error: unknown) => error);

  expect(String(offAfterFaults)).toContain('off until impd restarts');
});

test('a template evicted before its restore failed counts no failure', async () => {
  using ctx = setupStore();

  for (let count = 0; count < 3; count += 1) {
    const files = await ctx.store.buildTemplate(SHAPE);

    rmSync(join(ctx.dataDir, 'templates', files.key), { recursive: true });

    ctx.store.reportFailure(files, true);
  }

  const rebuilt = await ctx.store.buildTemplate(SHAPE);

  expect(ctx.store.find(SHAPE)).toEqual(rebuilt);
  expect(ctx.logs.join('\n')).not.toContain('restores failed');
});

test('past four templates, the least recently used goes', async () => {
  using ctx = setupStore();

  const shapes = [256, 512, 768, 1024].map((memoryMib) => ({ vcpus: 1, memoryMib }));

  for (const shape of shapes) {
    await ctx.store.buildTemplate(shape);

    ctx.clock.ms += 1000;
  }

  // the first is used again; the second is now the oldest
  ctx.store.find(shapes[0] ?? SHAPE);

  ctx.clock.ms += 1000;

  await ctx.store.buildTemplate({ vcpus: 2, memoryMib: 256 });

  const kept = shapes.map((shape) => ctx.store.find(shape) !== null);

  expect(kept).toEqual([true, false, true, true]);
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
