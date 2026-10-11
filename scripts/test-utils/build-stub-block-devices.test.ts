import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubBlockDevices } from './build-stub-block-devices';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-block-devices-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

test('it answers stat with a block device for the root partition, its disk and each device', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: { '/dev/vdb': {} },
  });

  const stat = createStubBin(ctx.dir, 'stat', scripts.stat);

  const result = Bun.spawnSync(
    ['bash', '-c', 'stat -L -c %F /dev/sda2; stat -L -c %F /dev/sda; stat -L -c %F /dev/vdb'],
    { env: { PATH: `${stat.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe(
    'block special file\nblock special file\nblock special file\n',
  );
});

test('it fails stat for a path that is no device in the table, as for a missing file', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: {},
  });

  const stat = createStubBin(ctx.dir, 'stat', scripts.stat);
  const result = Bun.spawnSync([join(stat.bin, 'stat'), '-L', '-c', '%F', '/dev/vdz']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: "stat: cannot statx '/dev/vdz': No such file or directory\n",
  });
});

test('it answers findmnt with the root partition as the source of /', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: {},
  });

  const findmnt = createStubBin(ctx.dir, 'findmnt', scripts.findmnt);

  expect(
    Bun.spawnSync([join(findmnt.bin, 'findmnt'), '-n', '-o', 'SOURCE', '/']).stdout.toString(),
  ).toBe('/dev/sda2\n');
});

test('it answers lsblk -s on the root partition with the partition and its disk', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: {},
  });

  const lsblk = createStubBin(ctx.dir, 'lsblk', scripts.lsblk);

  expect(
    Bun.spawnSync([
      join(lsblk.bin, 'lsblk'),
      '-n',
      '-s',
      '-o',
      'PATH',
      '/dev/sda2',
    ]).stdout.toString(),
  ).toBe('/dev/sda2\n/dev/sda\n');
});

test('it answers lsblk with a blank mount line for a device that is not mounted', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: { '/dev/vdb': {} },
  });

  const lsblk = createStubBin(ctx.dir, 'lsblk', scripts.lsblk);

  expect(
    Bun.spawnSync([
      join(lsblk.bin, 'lsblk'),
      '-n',
      '-o',
      'MOUNTPOINTS',
      '/dev/vdb',
    ]).stdout.toString(),
  ).toBe('\n');
});

test('it answers lsblk with the mount points of a mounted device', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: { '/dev/vdb': { mountpoints: ['/mnt/a', '/mnt/b'] } },
  });

  const lsblk = createStubBin(ctx.dir, 'lsblk', scripts.lsblk);

  expect(
    Bun.spawnSync([
      join(lsblk.bin, 'lsblk'),
      '-n',
      '-o',
      'MOUNTPOINTS',
      '/dev/vdb',
    ]).stdout.toString(),
  ).toBe('/mnt/a\n/mnt/b\n');
});

test('it answers lsblk with the device and then its partitions', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: { '/dev/vdb': { partitions: ['/dev/vdb1'] } },
  });

  const lsblk = createStubBin(ctx.dir, 'lsblk', scripts.lsblk);

  expect(
    Bun.spawnSync([join(lsblk.bin, 'lsblk'), '-n', '-o', 'PATH', '/dev/vdb']).stdout.toString(),
  ).toBe('/dev/vdb\n/dev/vdb1\n');
});

test('it answers blkid with the type and the label of a device', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: { '/dev/vdb': { type: 'zfs_member', label: 'tank' } },
  });

  const blkid = createStubBin(ctx.dir, 'blkid', scripts.blkid);

  const result = Bun.spawnSync(
    ['bash', '-c', 'blkid -p -s TYPE -o value /dev/vdb; blkid -p -s LABEL -o value /dev/vdb'],
    { env: { PATH: `${blkid.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('zfs_member\ntank\n');
});

test('it answers the blkid probe of a device with a type with that type', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: { '/dev/vdb': { type: 'ext4' } },
  });

  const blkid = createStubBin(ctx.dir, 'blkid', scripts.blkid);
  const result = Bun.spawnSync([join(blkid.bin, 'blkid'), '-p', '/dev/vdb']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '/dev/vdb: TYPE="ext4"\n',
  });
});

test('it answers the blkid probe of a device with a signature and no type with a partition table', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: { '/dev/vdb': { signature: true } },
  });

  const blkid = createStubBin(ctx.dir, 'blkid', scripts.blkid);
  const result = Bun.spawnSync([join(blkid.bin, 'blkid'), '-p', '/dev/vdb']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '/dev/vdb: PTTYPE="gpt"\n',
  });
});

test('it exits 2 from blkid for each tag an empty device lacks, as blkid does', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: { '/dev/vdb': {} },
  });

  const blkid = createStubBin(ctx.dir, 'blkid', scripts.blkid);

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'blkid -p -s TYPE -o value /dev/vdb; echo $?; blkid -p -s LABEL -o value /dev/vdb; echo $?; blkid -p /dev/vdb; echo $?',
    ],
    { env: { PATH: `${blkid.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('2\n2\n2\n');
});

test('it fails each call it does not model as unexpected', () => {
  const ctx = setupTest();

  const scripts = buildStubBlockDevices({
    root: { source: '/dev/sda2', disk: '/dev/sda' },
    devices: {},
  });

  createStubBin(ctx.dir, 'findmnt', scripts.findmnt);
  createStubBin(ctx.dir, 'lsblk', scripts.lsblk);

  const blkid = createStubBin(ctx.dir, 'blkid', scripts.blkid);

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'findmnt -n -o TARGET /; echo $?; lsblk -n -o PATH /dev/vdz; echo $?; blkid -p /dev/vdz; echo $?',
    ],
    { env: { PATH: `${blkid.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    stdout: '1\n1\n4\n',
    stderr:
      'unexpected: findmnt -n -o TARGET /\nunexpected: lsblk -n -o PATH /dev/vdz\nunexpected: blkid -p /dev/vdz\n',
  });
});
