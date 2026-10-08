import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage, findImageByName } from '../db/images';
import { createImp, findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import {
  buildImagePaths,
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { BUILDER_IMAGE } from './builder-imps';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'template-service-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  // a new disk stays the size of its image, since the clone copies every byte
  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    }),
    defaultDiskBytes: 0,
  };

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // the freezes, thaws and clones of disks, in the order they happen
  const events: string[] = [];

  const impd = await createImpd(config, {
    db,
    rootToken: 'root-token',
    storage: createXfsBackend({
      dataDir,
      cloneFile: async (source, target) => {
        await copyFile(source, target);

        events.push(`clone ${source.slice(dataDir.length)}`);
      },
    }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so a template never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // Firecracker, the kernel and the CPU as this host reports them
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },
    egress: {
      runNft: () => Promise.resolve(),
      flushConnections: () => Promise.resolve(),
      flushPair: () => Promise.resolve(),
      readForwardRules: () => Promise.resolve(''),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
      readConnected4: () => Promise.resolve(['172.17.0.0/16']),
      readConnected6: () => Promise.resolve([]),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
    },
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
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

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  return { dataDir, db, vmm, events, impd };
}

test('it freezes a running imp around the clone of its disk', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const before = ctx.events.length;

  await ctx.impd.templates.createTemplate('dev', 'tools');

  expect(ctx.events.slice(before)).toStrictEqual([
    'freeze',
    `clone /imps/${dev.id}/disk.ext4`,
    'thaw',
  ]);
});

test('it adds a template image named for its imp', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const image = await ctx.impd.templates.createTemplate('dev', 'tools');

  // the row's id, size and times come from the store and the disk
  expect(image).toMatchObject({
    name: 'tools',
    ref: 'imp:dev',
    source: 'imp',
    sourceImp: 'dev',
    digest: expect.stringMatching(/^imp-[\da-f\-]{36}$/v) as unknown,
  });
});

test('it writes the imp disk as the template rootfs', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await writeFile(buildImpPaths(ctx.dataDir, dev.id).disk, 'tools installed');

  const image = await ctx.impd.templates.createTemplate('dev', 'tools');

  expect(readFile(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'utf8')).resolves.toBe(
    'tools installed',
  );
});

test('it copies the source image config into the template', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');
  await Bun.write(join(ctx.dataDir, 'images', 'base', 'config.json'), '{"User":"dev"}');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const image = await ctx.impd.templates.createTemplate('dev', 'tools');

  expect(readFile(buildImagePaths(ctx.dataDir, image.digest).config, 'utf8')).resolves.toBe(
    '{"User":"dev"}',
  );
});

test('it wakes a sleeping imp and freezes it before the clone', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.imps.sleepImp('dev');

  const before = ctx.events.length;

  await ctx.impd.templates.createTemplate('dev', 'woken');

  expect(ctx.vmm.wakes).toHaveLength(1);
  expect(ctx.events[before]).toBe('freeze');
});

test('it clones a stopped imp without a freeze', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.impd.imps.stopImp('dev');

  const before = ctx.events.length;

  await ctx.impd.templates.createTemplate('dev', 'cold');

  expect(ctx.events.slice(before)).toStrictEqual([`clone /imps/${dev.id}/disk.ext4`]);
});

test('it refuses a template of an imp that is still being created', async () => {
  const ctx = await setupTest();

  const base = await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  // a row as a create writes it first, before its disk and its boot
  await createImp(ctx.db, {
    name: 'dev',
    imageId: base.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 7,
    ip: '10.66.0.9',
  });

  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  expect(creating).rejects.toMatchObject({
    code: 'INVALID_STATE',
    message: 'cannot template an imp that is creating (allowed: running, sleeping, stopped, error)',
  });
});

test('it refuses the builders image name for a template', async () => {
  const ctx = await setupTest();

  const creating = ctx.impd.templates.createTemplate('dev', BUILDER_IMAGE);

  expect(creating).rejects.toMatchObject({
    code: 'CONFLICT',
    message: `the image name ${BUILDER_IMAGE} is impd's, for its image builders; pick another`,
  });
});

test('it gives an imp from a template the template disk', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await writeFile(buildImpPaths(ctx.dataDir, dev.id).disk, 'golden');

  await ctx.impd.templates.createTemplate('dev', 'tools');

  const copy = await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  expect(readFile(buildImpPaths(ctx.dataDir, copy.id).disk, 'utf8')).resolves.toBe('golden');
});

test('it boots an imp from a template with an identity reset', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  const before = ctx.vmm.boots.length;

  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  expect(ctx.vmm.boots.slice(before)).toStrictEqual([{ hostname: 'copy', isIdentityReset: true }]);
});

test('it clears the pending reset once the first boot reports it done', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  const copy = await findImpByName(ctx.db, 'copy');

  expect(copy?.isIdentityResetPending).toBeFalse();
});

test('it boots a template copy without a reset after its first boot', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });
  await ctx.impd.imps.stopImp('copy');

  const before = ctx.vmm.boots.length;

  await ctx.impd.imps.startImp('copy');

  expect(ctx.vmm.boots.slice(before)).toStrictEqual([{ hostname: 'copy', isIdentityReset: false }]);
});

test('it boots an imp from a docker image without a reset', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'plain', image: 'base' });

  expect(ctx.vmm.boots).toStrictEqual([{ hostname: 'plain', isIdentityReset: false }]);
});

test('it marks a template copy made stopped as owing the reset', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools', start: false });

  const stopped = await findImpByName(ctx.db, 'copy');

  expect(stopped?.isIdentityResetPending).toBeTrue();
});

test('it resets a template copy made stopped on its first boot', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools', start: false });

  const before = ctx.vmm.boots.length;

  await ctx.impd.imps.startImp('copy');

  expect(ctx.vmm.boots.slice(before)).toStrictEqual([{ hostname: 'copy', isIdentityReset: true }]);
});

test('it moves a template made again to a new disk under the same image and drops the old disk', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const first = await ctx.impd.templates.createTemplate('dev', 'tools');
  const second = await ctx.impd.templates.createTemplate('dev', 'tools');

  expect(second.id).toBe(first.id);
  expect(second.digest).not.toBe(first.digest);
  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).dir)).toBeFalse();
});

test('it gives imps made after a template is made again its new disk, and older imps keep theirs', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await writeFile(buildImpPaths(ctx.dataDir, dev.id).disk, 'v1');

  await ctx.impd.templates.createTemplate('dev', 'tools');

  const old = await ctx.impd.imps.createImp({ name: 'old', image: 'tools' });

  await writeFile(buildImpPaths(ctx.dataDir, dev.id).disk, 'v2');

  await ctx.impd.templates.createTemplate('dev', 'tools');

  const made = await ctx.impd.imps.createImp({ name: 'new', image: 'tools' });
  const oldDisk = await readFile(buildImpPaths(ctx.dataDir, old.id).disk, 'utf8');
  const newDisk = await readFile(buildImpPaths(ctx.dataDir, made.id).disk, 'utf8');

  expect(oldDisk).toBe('v1');
  expect(newDisk).toBe('v2');
});

test('it refuses a template over the name of a docker image', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const creating = ctx.impd.templates.createTemplate('dev', 'base');

  expect(creating).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image base is a docker image; give the template a name of its own',
  });
});

// refused before any docker call
test('it refuses a docker image add over the name of a template', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  const adding = ctx.impd.images.addImage('ubuntu:24.04', 'tools');

  expect(adding).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image tools is a template; make it again from an imp, or pick another name',
  });
});

test('it refuses an imp disk smaller than its template disk', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base', diskMib: 64 });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  const creating = ctx.impd.imps.createImp({ name: 'small', image: 'tools', diskMib: 32 });

  expect(creating).rejects.toMatchObject({
    message: "a disk of 32 MiB is smaller than template tools's disk (64 MiB)",
  });
});

test('it gives an imp from a template at least the template disk size', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base', diskMib: 64 });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  const sized = await ctx.impd.imps.createImp({ name: 'sized', image: 'tools' });

  expect(sized.diskMib).toBe(64);
});

test('it refuses to remove a template an imp uses', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  const removing = ctx.impd.images.removeImage('tools');

  expect(removing).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image tools is used by 1 imp(s)',
  });
});

test('it removes a template no imp uses, and its disk', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const image = await ctx.impd.templates.createTemplate('dev', 'tools');

  await ctx.impd.images.removeImage('tools');

  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).dir)).toBeFalse();
});

test('it resets a fork of a template copy that never booted', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools', start: false });

  const before = ctx.vmm.boots.length;

  await ctx.impd.checkpoints.forkImp({ source: 'copy', name: 'fork' });

  expect(ctx.vmm.boots.slice(before)).toStrictEqual([{ hostname: 'fork', isIdentityReset: true }]);
});

// a fork of a booted copy holds that copy's new identity already
test('it boots a fork of a booted template copy without a reset', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');
  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  const before = ctx.vmm.boots.length;

  await ctx.impd.checkpoints.forkImp({ source: 'copy', name: 'later' });

  expect(ctx.vmm.boots.slice(before)).toStrictEqual([
    { hostname: 'later', isIdentityReset: false },
  ]);
});

test('it keeps the reset pending when the boot reports it failed', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  ctx.vmm.setIdentityReset('failed');

  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });

  const copy = await findImpByName(ctx.db, 'copy');

  expect(copy?.isIdentityResetPending).toBeTrue();
});

test('it keeps the reset pending when a boot reports nothing of it', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  ctx.vmm.setIdentityReset('failed');

  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });
  await ctx.impd.imps.stopImp('copy');

  ctx.vmm.setIdentityReset(undefined);

  await ctx.impd.imps.startImp('copy');

  const copy = await findImpByName(ctx.db, 'copy');

  expect(copy?.isIdentityResetPending).toBeTrue();
});

test('it clears a pending reset once a later boot reports it done', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.templates.createTemplate('dev', 'tools');

  ctx.vmm.setIdentityReset('failed');

  await ctx.impd.imps.createImp({ name: 'copy', image: 'tools' });
  await ctx.impd.imps.stopImp('copy');

  ctx.vmm.setIdentityReset('ok');

  await ctx.impd.imps.startImp('copy');

  const copy = await findImpByName(ctx.db, 'copy');

  expect(copy?.isIdentityResetPending).toBeFalse();
});

test('it thaws an imp whose clone fails while it is frozen', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  // a disk gone from under the imp fails its clone
  await rm(buildImpPaths(ctx.dataDir, dev.id).disk);

  const before = ctx.events.length;
  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  await creating.catch(() => {});

  expect(creating).rejects.toMatchObject({ code: 'ENOENT' });
  expect(ctx.events.slice(before)).toStrictEqual(['freeze', 'thaw']);
});

test('it leaves no template image when the clone fails', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  // a disk gone from under the imp fails its clone
  await rm(buildImpPaths(ctx.dataDir, dev.id).disk);

  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  await creating.catch(() => {});

  const tools = await findImageByName(ctx.db, 'tools');

  expect(creating).rejects.toMatchObject({ code: 'ENOENT' });
  expect(tools).toBeUndefined();
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual(['base']);
});

test('it fails with the clone error when the clone fails', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const dev = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  // a disk gone from under the imp fails its clone
  await rm(buildImpPaths(ctx.dataDir, dev.id).disk);

  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  expect(creating).rejects.toMatchObject({ code: 'ENOENT' });
});

test('it removes the cloned disk and rethrows when the image row fails to write', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  // the database refuses every template row
  await sql`CREATE TRIGGER refuse_templates BEFORE INSERT ON images WHEN NEW.source = 'imp'
    BEGIN SELECT RAISE(ABORT, 'template rows refused'); END`.execute(ctx.db);

  const creating = ctx.impd.templates.createTemplate('dev', 'tools');

  expect(creating).rejects.toThrow('template rows refused');
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual(['base']);
});
