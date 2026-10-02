import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { loadConfig } from '../config';
import { readErrorMessage } from '../read-error-message';
import { readRejection } from '../read-rejection';
import { buildSystemDrivesDir } from './data-layout';
import { removeUnusedSystemDrives } from './remove-unused-system-drives';
import { setupSystemFiles } from './setup-system-files';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(`${tmpdir()}/imp-system-files-`);

  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setup(dir: string, drive: string) {
  writeFileSync(`${dir}/vmlinux`, 'Linux version 6.1.188 (imp@imp)\0');
  writeFileSync(`${dir}/drive.squashfs`, drive);

  const config = loadConfig({
    IMP_DATA_DIR: `${dir}/data`,
    IMP_KERNEL: `${dir}/vmlinux`,
    IMP_SYSTEM_DRIVE: `${dir}/drive.squashfs`,
  });

  return setupSystemFiles(config);
}

function deriveSha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

test('each system drive goes to its own path, and the one before it stays', async () => {
  await withTempDir(async (dir) => {
    const first = await setup(dir, 'drive a');
    const second = await setup(dir, 'drive b');
    const again = await setup(dir, 'drive b');

    const drivesDir = buildSystemDrivesDir(`${dir}/data`);

    expect(first.systemDrivePath).toBe(`${drivesDir}/${deriveSha256('drive a')}.squashfs`);
    expect(second.systemDrivePath).not.toBe(first.systemDrivePath);
    expect(again.systemDrivePath).toBe(second.systemDrivePath);
    expect(readFileSync(first.systemDrivePath, 'utf8')).toBe('drive a');
    expect(readFileSync(second.systemDrivePath, 'utf8')).toBe('drive b');
    expect(existsSync(first.kernelPath)).toBeTrue();
  });
});

test('it reports the hashes it installed by, for system.info', async () => {
  await withTempDir(async (dir) => {
    const files = await setup(dir, 'drive a');

    expect(files.info).toEqual({
      guestKernel: {
        version: '6.1.188',
        sha256: deriveSha256('Linux version 6.1.188 (imp@imp)\0'),
      },
      systemDrive: { sha256: deriveSha256('drive a') },
    });
  });
});

test('without IMP_SYSTEM_DRIVE the drive in the data dir is the source', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(`${dir}/vmlinux`, 'kernel');

    const config = loadConfig({ IMP_DATA_DIR: dir, IMP_KERNEL: `${dir}/vmlinux` });

    const error = await readRejection(setupSystemFiles(config));

    expect(readErrorMessage(error)).toContain('imp-system.squashfs does not exist');

    mkdirSync(dirname(config.systemDriveSource), { recursive: true });
    writeFileSync(config.systemDriveSource, 'hand-placed drive');

    const files = await setupSystemFiles(config);

    // kept: a VM booted by an older impd may still run from it
    expect(existsSync(files.systemDrivePath)).toBeTrue();
    expect(existsSync(config.systemDriveSource)).toBeTrue();
  });
});

test('pruning keeps the drives named and deletes the rest and half copies', async () => {
  await withTempDir(async (dir) => {
    const kept = await setup(dir, 'drive a');
    const old = await setup(dir, 'drive b');

    writeFileSync(`${old.systemDrivePath}.new`, 'half');

    const removed = removeUnusedSystemDrives(
      `${dir}/data`,
      new Set([basename(kept.systemDrivePath)]),
    );

    const oldName = basename(old.systemDrivePath);

    expect(removed.toSorted()).toEqual([oldName, `${oldName}.new`]);
    expect(existsSync(kept.systemDrivePath)).toBeTrue();
    expect(existsSync(old.systemDrivePath)).toBeFalse();
  });
});
