import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { loadConfig } from '../config';
import { buildSystemDrivesDir } from './data-layout';
import { removeUnusedSystemDrives } from './remove-unused-system-drives';
import { setupSystemFiles } from './setup-system-files';

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(`${tmpdir()}/imp-system-files-`);

  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setup(dir: string, drive: string) {
  writeFileSync(`${dir}/vmlinux`, 'kernel');
  writeFileSync(`${dir}/drive.squashfs`, drive);

  const config = loadConfig({
    IMP_DATA_DIR: `${dir}/data`,
    IMP_KERNEL: `${dir}/vmlinux`,
    IMP_SYSTEM_DRIVE: `${dir}/drive.squashfs`,
  });

  return setupSystemFiles(config);
}

test('each system drive goes to its own path, and the one before it stays', () => {
  withTempDir((dir) => {
    const first = setup(dir, 'drive a');
    const second = setup(dir, 'drive b');
    const again = setup(dir, 'drive b');

    const sha = new Bun.CryptoHasher('sha256').update('drive a').digest('hex');

    expect(first.systemDrivePath).toBe(`${buildSystemDrivesDir(`${dir}/data`)}/${sha}.squashfs`);
    expect(second.systemDrivePath).not.toBe(first.systemDrivePath);
    expect(again.systemDrivePath).toBe(second.systemDrivePath);
    expect(readFileSync(first.systemDrivePath, 'utf8')).toBe('drive a');
    expect(readFileSync(second.systemDrivePath, 'utf8')).toBe('drive b');
    expect(readFileSync(first.kernelPath, 'utf8')).toBe('kernel');
  });
});

test('without IMP_SYSTEM_DRIVE the drive in the data dir is the source', () => {
  withTempDir((dir) => {
    writeFileSync(`${dir}/vmlinux`, 'kernel');

    const config = loadConfig({ IMP_DATA_DIR: dir, IMP_KERNEL: `${dir}/vmlinux` });

    expect(() => setupSystemFiles(config)).toThrow('imp-system.squashfs does not exist');

    mkdirSync(dirname(config.systemDriveSource), { recursive: true });
    writeFileSync(config.systemDriveSource, 'hand-placed drive');

    expect(existsSync(setupSystemFiles(config).systemDrivePath)).toBeTrue();
  });
});

test('pruning keeps the drives named and deletes the rest and half copies', () => {
  withTempDir((dir) => {
    const kept = setup(dir, 'drive a').systemDrivePath;
    const old = setup(dir, 'drive b').systemDrivePath;

    writeFileSync(`${old}.new`, 'half');

    const removed = removeUnusedSystemDrives(`${dir}/data`, new Set([kept]));

    expect(removed.toSorted()).toEqual([basename(old), `${basename(old)}.new`]);
    expect(existsSync(kept)).toBeTrue();
    expect(existsSync(old)).toBeFalse();
  });
});
