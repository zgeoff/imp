import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Imp } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createCheckpoint, listCheckpoints } from '../db/checkpoints';
import { createImage } from '../db/images';
import { subscribeImpWrites } from '../db/imp-write-feed';
import { createImp, findImpByName } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { openDatabase } from '../db/open-database';
import {
  buildImagePaths,
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../storage/data-layout';
import { CheckpointIdTakenError } from '../storage/storage-backend';
import { createXfsBackend } from '../storage/xfs-backend';
import { createZfsBackend } from '../storage/zfs/zfs-backend';
import { buildQueryGate } from '../test-utils/build-query-gate';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { buildStubZfs } from '../test-utils/build-stub-zfs';
import { findFreePorts } from '../test-utils/find-free-ports';
import {
  buildCheckpointId,
  createCheckpointService,
  isValidCheckpointLabel,
} from './checkpoint-service';

interface SetupOptions {
  // XFS clones files; ZFS, on the stub pool, snapshots datasets and checks
  // each new checkpoint id against the pool's snapshots
  readonly storage: 'xfs' | 'zfs';
}

async function setupTest(options: SetupOptions) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'checkpoint-service-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const opened = await openDatabase(':memory:');

  stack.defer(() => opened.destroy());

  // holds the first select that names `base` once armed: a fork reads its
  // source's image there, between its two locks of the source; impd and the
  // test share this handle, and so its write feed
  const gate = buildQueryGate('base');
  const db = opened.withPlugin(gate.plugin);

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one; a new
  // disk stays its image's size, since each clone copies every byte
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

  // freeze, thaw and each clone's source under the data dir, in order
  const events: string[] = [];
  const zfs = buildStubZfs({ root: 'tank/imp', rootDir: dataDir });

  const storages = {
    // each clone a real copy, recorded as it starts
    xfs: () =>
      createXfsBackend({
        dataDir,
        cloneFile: (source, target) => {
          events.push(`clone ${source.slice(dataDir.length)}`);

          return copyFile(source, target);
        },
      }),

    // the stub pool's zfs, streams and mount table, as setup-storage.sh
    // mounts the root dataset on the data dir
    zfs: () =>
      createZfsBackend({
        dataDir,
        root: 'tank/imp',
        run: zfs.run,
        streams: zfs.streams,
        readMounts: zfs.readMounts,
        readModuleVersion: () => '2.2.2-0ubuntu9',
        log: () => {},
      }),
  };

  const storage = storages[options.storage]();

  const impd = await createImpd(config, {
    db,

    // the bearer impd's token store starts with
    rootToken: 'root-token',

    storage,

    // what system.info reports; the drive's hash names the drive file above
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so a checkpoint never meets this machine's disk
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

    // the guest's fsfreeze around each consistent copy, recorded
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
  });

  stack.defer(() => {
    impd.diskUsage.stop();
  });

  return { config, db, dataDir, storage, impd, vmm, events, gate };
}

test('it makes an id of cp- and six letters that read unambiguously', () => {
  expect(buildCheckpointId()).toMatch(/^cp-[a-km-z2-9]{6}$/);
});

test('it picks each letter of an id from the random source', () => {
  expect(buildCheckpointId(() => 0)).toBe('cp-aaaaaa');
});

test.each([
  ['cp-abc', false],
  ['clean', true],
])('it judges the label %s valid: %p', (label, isValid) => {
  expect(isValidCheckpointLabel(label)).toBe(isValid);
});

test('it freezes a running imp around the clone and records the checkpoint', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const seen = ctx.events.length;

  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', 'clean');

  const disk = join(buildImpPaths(ctx.dataDir, imp.id).checkpointsDir, checkpoint.id, 'disk.ext4');

  const listed = await ctx.impd.checkpoints.listCheckpoints('dev');

  expect(ctx.events.slice(seen)).toStrictEqual([
    'freeze',
    `clone /imps/${imp.id}/disk.ext4`,
    'thaw',
  ]);

  expect(checkpoint).toMatchObject({ label: 'clean' });
  expect(readFileSync(disk, 'utf8')).toBe('rootfs');
  expect(listed).toStrictEqual([checkpoint]);
});

test('it clones a stopped imp without freezing it', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.impd.imps.stopImp('dev');

  const seen = ctx.events.length;

  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', undefined);

  expect(ctx.events.slice(seen)).toStrictEqual([`clone /imps/${imp.id}/disk.ext4`]);
  expect(checkpoint.label).toBeUndefined();
});

test('it thaws and leaves no checkpoint when the clone fails', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  // a disk that is gone fails the real copy
  rmSync(paths.disk);

  const seen = ctx.events.length;

  expect(ctx.impd.checkpoints.createCheckpoint('dev', undefined)).rejects.toMatchObject({
    code: 'ENOENT',
  });

  const rows = await listCheckpoints(ctx.db, imp.id);

  expect(ctx.events.slice(seen)).toStrictEqual([
    'freeze',
    `clone /imps/${imp.id}/disk.ext4`,
    'thaw',
  ]);

  expect(rows).toStrictEqual([]);
  expect(readdirSync(paths.checkpointsDir)).toStrictEqual([]);
});

test('it rejects a label another checkpoint of the imp holds', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.impd.checkpoints.createCheckpoint('dev', 'clean');

  expect(ctx.impd.checkpoints.createCheckpoint('dev', 'clean')).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'checkpoint', name: 'clean' },
  });
});

test('it rejects a label shaped like a checkpoint id', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  expect(ctx.impd.checkpoints.createCheckpoint('dev', 'cp-abc')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'a label must not start with cp-',
  });
});

test('it restores a running imp: kill, swap the disk, drop the snapshot, boot', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  writeFileSync(paths.disk, 'a=1');

  await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(paths.disk, 'a=2');
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(join(paths.snapshotDir, 'memory'), 'old');

  const restored = await ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1');
  const record = await findImpByName(ctx.db, 'dev');

  expect(restored.state).toBe('running');

  // the old guest's disk and memory are thrown away: no graceful shutdown
  expect(ctx.vmm.stops).toStrictEqual([{ pid: 1001, graceful: false }]);
  expect(readFileSync(paths.disk, 'utf8')).toBe('a=1');
  expect(existsSync(paths.snapshotDir)).toBe(false);
  expect(existsSync(`${paths.disk}.new`)).toBe(false);
  expect(record?.pid).toBe(1002);
});

test('it restores a stopped imp and leaves it stopped', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', undefined);

  const disk = buildImpPaths(ctx.dataDir, imp.id).disk;

  await ctx.impd.imps.stopImp('dev');

  writeFileSync(disk, 'changed');

  const restored = await ctx.impd.checkpoints.restoreCheckpoint('dev', checkpoint.id);

  expect(restored.state).toBe('stopped');
  expect(readFileSync(disk, 'utf8')).toBe('rootfs');
});

test('it forks a checkpoint into a new slot with its source’s shape', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const source = await ctx.impd.imps.createImp({
    name: 'dev',
    image: 'base',
    vcpus: 3,
    memoryMib: 1024,
  });

  const sourceDisk = buildImpPaths(ctx.dataDir, source.id).disk;

  writeFileSync(sourceDisk, 'a=1');

  await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(sourceDisk, 'a=2');

  const forked = await ctx.impd.checkpoints.forkImp({
    source: 'dev',
    name: 'old',
    checkpoint: 'v1',
  });

  expect(forked).toMatchObject({
    imp: { name: 'old', state: 'running', vcpus: 3, memoryMib: 1024, slot: 1 },
    sourceId: source.id,
  });

  expect(readFileSync(buildImpPaths(ctx.dataDir, forked.imp.id).disk, 'utf8')).toBe('a=1');
});

test('it forks the live disk, frozen, into a new imp with no checkpoints', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const source = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(buildImpPaths(ctx.dataDir, source.id).disk, 'a=2');

  const seen = ctx.events.length;

  const forked = await ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'now' });
  const forkCheckpoints = await ctx.impd.checkpoints.listCheckpoints('now');

  expect(ctx.events.slice(seen, seen + 3)).toStrictEqual([
    'freeze',
    `clone /imps/${source.id}/disk.ext4`,
    'thaw',
  ]);

  expect(forked).toMatchObject({ imp: { name: 'now', state: 'running', image: 'base', slot: 1 } });
  expect(readFileSync(buildImpPaths(ctx.dataDir, forked.imp.id).disk, 'utf8')).toBe('a=2');
  expect(forkCheckpoints).toStrictEqual([]);
});

test('it creates no imp when the fork’s checkpoint is unknown', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  expect(
    ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy', checkpoint: 'nope' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { kind: 'checkpoint', name: 'nope' } });

  const copy = await findImpByName(ctx.db, 'copy');

  expect(copy).toBeUndefined();
});

test('it creates no imp when the fork’s source is unknown', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  expect(ctx.impd.checkpoints.forkImp({ source: 'gone', name: 'copy' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });

  const copy = await findImpByName(ctx.db, 'copy');

  expect(copy).toBeUndefined();
});

test('it deletes a checkpoint by its label and keeps the others', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  const first = await ctx.impd.checkpoints.createCheckpoint('dev', 'one');
  const second = await ctx.impd.checkpoints.createCheckpoint('dev', 'two');

  await ctx.impd.checkpoints.deleteCheckpoint('dev', 'one');

  const checkpointsDir = buildImpPaths(ctx.dataDir, imp.id).checkpointsDir;

  const remaining = await ctx.impd.checkpoints.listCheckpoints('dev');

  expect(existsSync(join(checkpointsDir, first.id))).toBe(false);
  expect(remaining).toStrictEqual([second]);
});

test('it removes an imp’s checkpoints with the imp', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  await ctx.impd.checkpoints.createCheckpoint('dev', 'one');
  await ctx.impd.imps.destroyImp('dev');

  const rows = await listCheckpoints(ctx.db, imp.id);

  expect(existsSync(buildImpPaths(ctx.dataDir, imp.id).dir)).toBe(false);
  expect(rows).toStrictEqual([]);
});

test('it rejects a listing of an imp that does not exist', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  expect(ctx.impd.checkpoints.listCheckpoints('gone')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'gone' },
  });
});

test('it rejects a restore of an imp still being created', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  // a row a create left in `creating`, with a checkpoint to restore
  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.42.0.2',
  });

  await createCheckpoint(ctx.db, { id: 'cp-aaaaaa', impId: imp.id, label: 'v1', sizeBytes: 0 });

  expect(ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1')).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
});

test('it rejects a fork of the live disk of an imp still being created', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  // a row a create left in `creating`
  await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.42.0.2',
  });

  expect(ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });

  const copy = await findImpByName(ctx.db, 'copy');

  expect(copy).toBeUndefined();
});

test('it leaves a sleeping imp asleep with its memory when a restore’s clone fails', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  await ctx.impd.imps.sleepImp('dev');

  // a checkpoint disk that is gone fails the real copy
  rmSync(join(paths.checkpointsDir, checkpoint.id, 'disk.ext4'));

  const restore = ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1');

  expect(restore).rejects.toMatchObject({ code: 'ENOENT' });

  const record = await findImpByName(ctx.db, 'dev');

  expect(record?.state).toBe('sleeping');
  expect(existsSync(paths.memFile)).toBe(true);
  expect(existsSync(`${paths.disk}.new`)).toBe(false);
});

test('it leaves a running imp running on its own disk when a restore’s clone fails', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const checkpoint = await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(paths.disk, 'changed');

  // a checkpoint disk that is gone fails the real copy
  rmSync(join(paths.checkpointsDir, checkpoint.id, 'disk.ext4'));

  expect(ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1')).rejects.toMatchObject({
    code: 'ENOENT',
  });

  const record = await findImpByName(ctx.db, 'dev');

  expect(record).toMatchObject({ state: 'running', pid: 1001 });
  expect(ctx.vmm.stops).toStrictEqual([]);
  expect(readFileSync(paths.disk, 'utf8')).toBe('changed');
});

test('it leaves the imp stopped on its old disk when a restore’s swap fails after the kill', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  await ctx.impd.checkpoints.createCheckpoint('dev', 'v1');

  writeFileSync(paths.disk, 'changed');
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(join(paths.snapshotDir, 'memory'), 'old');

  // the kill waits here; the staged clone goes meanwhile, so the swap fails
  const kill = ctx.vmm.hold('stop');
  const restore = ctx.impd.checkpoints.restoreCheckpoint('dev', 'v1');

  await kill.reached;

  rmSync(`${paths.disk}.new`);

  kill.release();

  expect(restore).rejects.toMatchObject({ code: 'ENOENT' });

  const record = await findImpByName(ctx.db, 'dev');

  expect(ctx.vmm.stops).toStrictEqual([{ pid: 1001, graceful: false }]);
  expect(record).toMatchObject({ state: 'stopped', pid: null });
  expect(existsSync(paths.snapshotDir)).toBe(false);
  expect(readFileSync(paths.disk, 'utf8')).toBe('changed');
});

test('it refuses a fork whose source is destroyed before the disk copy and leaves nothing', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  // the fork stops at its read of the source's image, past its first lock
  ctx.gate.arm();

  const fork = ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy' });

  await ctx.gate.reached;

  await ctx.impd.imps.destroyImp('dev');

  ctx.gate.release();

  expect(fork).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'imp dev changed during the fork; the fork was not made',
  });

  const imps = await ctx.impd.imps.listImps();

  expect(imps).toStrictEqual([]);
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual([]);
});

test('it refuses a fork whose source is made again under its name before the disk copy', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  // the fork stops at its read of the source's image, past its first lock
  ctx.gate.arm();

  const fork = ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy' });

  await ctx.gate.reached;

  await ctx.impd.imps.destroyImp('dev');

  const remade = await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  ctx.gate.release();

  expect(fork).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'imp dev changed during the fork; the fork was not made',
  });

  const imps = await ctx.impd.imps.listImps();

  expect(imps).toMatchObject([{ id: remade.id, name: 'dev' }]);
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual([remade.id]);
});

test('it leaves an imp that took a refused fork’s name before the fork’s cleanup', async () => {
  const ctx = await setupTest({ storage: 'xfs' });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  // the fork stops at its read of the source's image, past its first lock
  ctx.gate.arm();

  const fork = ctx.impd.checkpoints.forkImp({ source: 'dev', name: 'copy' });

  await ctx.gate.reached;

  await ctx.impd.imps.destroyImp('dev');
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  // The next write is the fork's row, made under the fork's lock: `imp rm` of
  // the fork, then a new `copy`, queue on that lock ahead of the refused
  // fork's cleanup.
  const queued: { row?: ImpRecord; removed?: Promise<void>; taker?: Promise<Imp> } = {};

  const unwatch = subscribeImpWrites(ctx.db, (write) => {
    unwatch();

    // a throw here fails the fork's insert, and with it the test
    if (write.kind !== 'added') {
      throw new Error(`the first write was ${write.kind}, not the fork's row`);
    }

    queued.row = write.imp;
    queued.removed = ctx.impd.imps.destroyImpId(write.imp.id);

    queued.taker = ctx.impd.imps.lockImpId(write.imp.id, () =>
      ctx.impd.imps.createImp({ name: 'copy', image: image.name }),
    );
  });

  onTestFinished(unwatch);

  ctx.gate.release();

  expect(fork).rejects.toMatchObject({ code: 'CONFLICT' });

  invariant(queued.row);
  invariant(queued.removed);
  invariant(queued.taker);

  await queued.removed;

  const taker = await queued.taker;
  const copy = await findImpByName(ctx.db, 'copy');
  const imps = await ctx.impd.imps.listImps();

  expect(queued.row.name).toBe('copy');
  expect(taker.id).not.toBe(queued.row.id);
  expect(copy?.id).toBe(taker.id);
  expect(imps.map((imp) => imp.name).toSorted()).toStrictEqual(['copy', 'dev']);
});

test('it draws a new id when the pool holds a snapshot by the drawn one', async () => {
  const ctx = await setupTest({ storage: 'zfs' });

  // the stub pool keeps no files: the image is a dataset only, and the
  // imp's disk file is there before its clone
  await ctx.storage.createImage('sha256:base', () => Promise.resolve());

  writeFileSync(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const impId = '01890000-0000-7000-8000-000000000001';
  const disk = ctx.storage.resolveImpPaths(impId).disk;

  mkdirSync(dirname(disk), { recursive: true });
  writeFileSync(disk, 'rootfs');

  await ctx.impd.imps.createImp({ id: impId, name: 'dev', image: 'base' });

  // six draws of 0 make cp-aaaaaa, six of 1/32 make cp-bbbbbb
  const draws = [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1 / 32,
    1 / 32,
    1 / 32,
    1 / 32,
    1 / 32,
    1 / 32,
  ];

  const checkpoints = createCheckpointService({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    storage: ctx.storage,
    diskBudget: ctx.impd.diskBudget,
    log: () => {},

    // the guest's fsfreeze; the stub VMM's guest has no agent to run it
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
    random: () => draws.shift() ?? Number.NaN,
  });

  await checkpoints.createCheckpoint('dev', 'first');

  const second = await checkpoints.createCheckpoint('dev', 'second');

  expect(second.id).toBe('cp-bbbbbb');
});

test('it gives up when every drawn id names a snapshot in the pool', async () => {
  const ctx = await setupTest({ storage: 'zfs' });

  // the stub pool keeps no files: the image is a dataset only, and the
  // imp's disk file is there before its clone
  await ctx.storage.createImage('sha256:base', () => Promise.resolve());

  writeFileSync(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const impId = '01890000-0000-7000-8000-000000000001';
  const disk = ctx.storage.resolveImpPaths(impId).disk;

  mkdirSync(dirname(disk), { recursive: true });
  writeFileSync(disk, 'rootfs');

  await ctx.impd.imps.createImp({ id: impId, name: 'dev', image: 'base' });

  // every draw is 0: every id is cp-aaaaaa
  const checkpoints = createCheckpointService({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    storage: ctx.storage,
    diskBudget: ctx.impd.diskBudget,
    log: () => {},

    // the guest's fsfreeze; the stub VMM's guest has no agent to run it
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
    random: () => 0,
  });

  await checkpoints.createCheckpoint('dev', 'first');

  expect(checkpoints.createCheckpoint('dev', 'second')).rejects.toBeInstanceOf(
    CheckpointIdTakenError,
  );

  const listed = await checkpoints.listCheckpoints('dev');

  expect(listed).toMatchObject([{ id: 'cp-aaaaaa', label: 'first' }]);
});
