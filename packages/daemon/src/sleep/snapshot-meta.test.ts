import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImpPaths } from '../storage/data-layout';
import { buildMockHostIdentity } from '../test-utils/build-mock-host-identity';
import {
  buildSnapshotIdentity,
  findColdBootReason,
  hasSnapshot,
  readLoadingMeta,
  readSnapshotMeta,
  removeSnapshot,
  removeSnapshotMeta,
  resetSnapshotLoading,
  setSnapshotLoading,
  writeSnapshotMeta,
} from './snapshot-meta';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-snapshot-meta-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const paths = buildImpPaths(dir, 'imp1');

  // the snapshot's dir, which every sleep makes before it writes there
  mkdirSync(paths.snapshotDir, { recursive: true });

  return { dir, paths };
}

test('#findColdBootReason loads a snapshot on a host with the same identity', () => {
  const ctx = setupTest();
  const drive = join(ctx.dir, 'drive.squashfs');

  writeFileSync(drive, 'drive');

  const host = buildMockHostIdentity({ systemDrivePath: drive });

  expect(findColdBootReason({ ...host, agentVersion: '0.1.0' }, host)).toBeNull();
});

test('#findColdBootReason loads a snapshot from another guest kernel and drive', () => {
  const ctx = setupTest();
  const drive = join(ctx.dir, 'drive.squashfs');

  writeFileSync(drive, 'drive');

  const host = buildMockHostIdentity({ systemDrivePath: drive });

  expect(
    findColdBootReason({ ...host, guestKernel: 'old-kernel', systemDrive: 'old-drive' }, host),
  ).toBeNull();
});

test.each([
  [
    'firecrackerVersion',
    { firecrackerVersion: 'v1.16.0' },
    'firecrackerVersion changed (v1.16.0 → v1.17.0)',
  ],
  [
    'snapshotVersion',
    { snapshotVersion: 'v11.0.0' },
    'snapshotVersion changed (v11.0.0 → v12.0.0)',
  ],
  ['hostKernel', { hostKernel: '6.1.0' }, 'hostKernel changed (6.1.0 → 6.6.87)'],
  ['cpuModel', { cpuModel: 'Other CPU' }, 'the CPU changed (Other CPU → Test CPU)'],
  ['cpuFlags', { cpuFlags: 'other-flags' }, 'the CPU flags changed'],
])('#findColdBootReason boots cold when the %s changed', (_key, change, reason) => {
  const ctx = setupTest();
  const drive = join(ctx.dir, 'drive.squashfs');

  writeFileSync(drive, 'drive');

  const host = buildMockHostIdentity({
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    cpuModel: 'Test CPU',
    cpuFlags: 'test-flags',
    systemDrivePath: drive,
  });

  expect(findColdBootReason({ ...host, ...change }, host)).toBe(reason);
});

test('#findColdBootReason boots cold when the drive the snapshot names is gone', () => {
  const ctx = setupTest();
  const host = buildMockHostIdentity({ systemDrivePath: join(ctx.dir, 'drive.squashfs') });

  expect(
    findColdBootReason(
      { ...host, systemDrive: 'abcdef0123456789', systemDrivePath: join(ctx.dir, 'gone') },
      host,
    ),
  ).toBe('its agent drive abcdef012345 is gone');
});

test('#findColdBootReason boots cold a snapshot that names no drive', () => {
  const host = buildMockHostIdentity();

  const snapshot = {
    firecrackerVersion: host.firecrackerVersion,
    snapshotVersion: host.snapshotVersion,
    hostKernel: host.hostKernel,
    guestKernel: host.guestKernel,
    systemDrive: host.systemDrive,
  };

  expect(findColdBootReason(snapshot, host)).toBe('the snapshot is from an older impd');
});

test('#findColdBootReason boots cold a snapshot from another IPv6 prefix', () => {
  const ctx = setupTest();
  const drive = join(ctx.dir, 'drive.squashfs');

  writeFileSync(drive, 'drive');

  const host = buildMockHostIdentity({
    systemDrivePath: drive,
    ipv6Prefix: 'fd12:3456:789a::/64',
  });

  expect(findColdBootReason({ ...host, ipv6Prefix: 'fd00:1::/64' }, host)).toBe(
    'the IPv6 prefix changed (fd00:1::/64 → fd12:3456:789a::/64)',
  );
});

test('#findColdBootReason boots cold a snapshot with a prefix on a host with IPv6 off', () => {
  const ctx = setupTest();
  const drive = join(ctx.dir, 'drive.squashfs');

  writeFileSync(drive, 'drive');

  const host = buildMockHostIdentity({ systemDrivePath: drive, ipv6Prefix: null });

  expect(findColdBootReason({ ...host, ipv6Prefix: 'fd12:3456:789a::/64' }, host)).toBe(
    'the IPv6 prefix changed (fd12:3456:789a::/64 → off)',
  );
});

test.each([
  ['no prefix', null],
  ['a prefix left out by an older impd', undefined],
])('#findColdBootReason loads a snapshot with %s on a host with IPv6', (_label, ipv6Prefix) => {
  const ctx = setupTest();
  const drive = join(ctx.dir, 'drive.squashfs');

  writeFileSync(drive, 'drive');

  const host = buildMockHostIdentity({
    systemDrivePath: drive,
    ipv6Prefix: 'fd12:3456:789a::/64',
  });

  expect(findColdBootReason({ ...host, ipv6Prefix }, host)).toBeNull();
});

test('#buildSnapshotIdentity records the identity a VM booted with, without its boot reason', () => {
  const host = buildMockHostIdentity();
  const vm = { ...host, agentVersion: '0.1.0', bootReason: 'wake failed' };

  expect(buildSnapshotIdentity(vm, host)).toStrictEqual({ ...host, agentVersion: '0.1.0' });
});

test('#buildSnapshotIdentity records for a VM with no identity one that boots cold', () => {
  const host = buildMockHostIdentity();
  const identity = buildSnapshotIdentity(null, host);

  expect(identity).toStrictEqual({
    firecrackerVersion: host.firecrackerVersion,
    snapshotVersion: host.snapshotVersion,
    hostKernel: host.hostKernel,
    guestKernel: 'unknown',
    systemDrive: 'unknown',
  });
});

test('#findColdBootReason boots cold the snapshot of a VM that had no identity', () => {
  const host = buildMockHostIdentity();
  const identity = buildSnapshotIdentity(null, host);

  expect(findColdBootReason(identity, host)).toBe('the snapshot is from an older impd');
});

test('#readSnapshotMeta reads the meta of an older impd', () => {
  const ctx = setupTest();

  const meta = {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: '1b2c3d',
    systemDrive: '4e5f6a',
    createdAt: 1,
    memoryMib: 512,
    ramMib: 60,
  };

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');
  writeFileSync(ctx.paths.snapshotMeta, JSON.stringify(meta));

  expect(readSnapshotMeta(ctx.paths)).toStrictEqual(meta);
});

test('#readSnapshotMeta reads the meta of a newer impd without its unknown fields', () => {
  const ctx = setupTest();

  const meta = {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: '1b2c3d',
    systemDrive: '4e5f6a',
    createdAt: 1,
    memoryMib: 512,
    ramMib: 60,
  };

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');
  writeFileSync(ctx.paths.snapshotMeta, JSON.stringify({ ...meta, futureField: true }));

  expect(readSnapshotMeta(ctx.paths)).toStrictEqual(meta);
});

test('#readSnapshotMeta reads no snapshot without its memory file', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.vmstate, 'vmstate');

  writeFileSync(
    ctx.paths.snapshotMeta,
    JSON.stringify({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.6.87',
      guestKernel: '1b2c3d',
      systemDrive: '4e5f6a',
      createdAt: 1,
      memoryMib: 512,
      ramMib: 60,
    }),
  );

  expect(readSnapshotMeta(ctx.paths)).toBeNull();
});

test('#readSnapshotMeta reads a planted symlink as meta.json as no snapshot', () => {
  const ctx = setupTest();
  const outside = join(ctx.dir, 'outside');

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');

  writeFileSync(
    outside,
    JSON.stringify({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.6.87',
      guestKernel: '1b2c3d',
      systemDrive: '4e5f6a',
      createdAt: 1,
      memoryMib: 512,
      ramMib: 60,
    }),
  );

  symlinkSync(outside, ctx.paths.snapshotMeta);

  expect(readSnapshotMeta(ctx.paths)).toBeNull();
});

test('#readSnapshotMeta reads a planted FIFO as meta.json as no snapshot without blocking', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');

  const mkfifo = Bun.spawnSync(['mkfifo', ctx.paths.snapshotMeta]);

  expect(mkfifo.exitCode).toBe(0);
  expect(readSnapshotMeta(ctx.paths)).toBeNull();
});

test('#writeSnapshotMeta replaces a planted symlink and leaves its target untouched', () => {
  const ctx = setupTest();
  const outside = join(ctx.dir, 'outside');

  const meta = {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: '1b2c3d',
    systemDrive: '4e5f6a',
    createdAt: 1,
    memoryMib: 512,
    ramMib: 60,
  };

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, ctx.paths.snapshotMeta);
  writeSnapshotMeta(ctx.paths, meta);

  expect(readFileSync(outside, 'utf8')).toBe('untouched');
  expect(readSnapshotMeta(ctx.paths)).toStrictEqual(meta);
});

test('#hasSnapshot finds a complete snapshot', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');

  writeSnapshotMeta(ctx.paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: '1b2c3d',
    systemDrive: '4e5f6a',
    createdAt: 1,
    memoryMib: 512,
    ramMib: 60,
  });

  expect(hasSnapshot(ctx.paths)).toBeTrue();
});

test('#hasSnapshot finds no snapshot without its meta', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');

  expect(hasSnapshot(ctx.paths)).toBeFalse();
});

test('#setSnapshotLoading takes the meta away while a wake loads it', () => {
  const ctx = setupTest();

  const meta = {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: '1b2c3d',
    systemDrive: '4e5f6a',
    createdAt: 1,
    memoryMib: 512,
    ramMib: 60,
  };

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');
  writeSnapshotMeta(ctx.paths, meta);
  setSnapshotLoading(ctx.paths);

  expect(readSnapshotMeta(ctx.paths)).toBeNull();
  expect(readLoadingMeta(ctx.paths)).toStrictEqual(meta);
});

test('#resetSnapshotLoading gives the meta of a load that never started the guest back', () => {
  const ctx = setupTest();

  const meta = {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: '1b2c3d',
    systemDrive: '4e5f6a',
    createdAt: 1,
    memoryMib: 512,
    ramMib: 60,
  };

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');
  writeSnapshotMeta(ctx.paths, meta);
  setSnapshotLoading(ctx.paths);
  resetSnapshotLoading(ctx.paths);

  expect(readSnapshotMeta(ctx.paths)).toStrictEqual(meta);
  expect(readLoadingMeta(ctx.paths)).toBeNull();
});

test('#readLoadingMeta reads no meta when no load is under way', () => {
  const ctx = setupTest();

  expect(readLoadingMeta(ctx.paths)).toBeNull();
});

test('#removeSnapshotMeta drops the meta and the meta of a load under way', () => {
  const ctx = setupTest();

  const meta = {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.6.87',
    guestKernel: '1b2c3d',
    systemDrive: '4e5f6a',
    createdAt: 1,
    memoryMib: 512,
    ramMib: 60,
  };

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');
  writeSnapshotMeta(ctx.paths, meta);
  setSnapshotLoading(ctx.paths);
  writeSnapshotMeta(ctx.paths, meta);
  removeSnapshotMeta(ctx.paths);

  expect(readSnapshotMeta(ctx.paths)).toBeNull();
  expect(readLoadingMeta(ctx.paths)).toBeNull();
});

test('#removeSnapshotMeta keeps the memory and the state files', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');
  removeSnapshotMeta(ctx.paths);

  expect(readFileSync(ctx.paths.vmstate, 'utf8')).toBe('vmstate');
  expect(readFileSync(ctx.paths.memFile, 'utf8')).toBe('mem');
});

test('#removeSnapshot removes the whole snapshot dir', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');
  removeSnapshot(ctx.paths);

  expect(existsSync(ctx.paths.snapshotDir)).toBeFalse();
});

test('#removeSnapshot never touches the disk of the imp', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, 'disk');
  writeFileSync(ctx.paths.vmstate, 'vmstate');
  removeSnapshot(ctx.paths);

  expect(readFileSync(ctx.paths.disk, 'utf8')).toBe('disk');
});
