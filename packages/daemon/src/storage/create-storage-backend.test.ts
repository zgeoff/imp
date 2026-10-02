import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStorageMarker } from './create-storage-backend';

function setupDataDir() {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-marker-test-`);

  return {
    dataDir,
    [Symbol.dispose]: () => {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('it marks a new data dir and then refuses the other backend', () => {
  using ctx = setupDataDir();

  checkStorageMarker(ctx.dataDir, 'zfs');

  expect(readFileSync(join(ctx.dataDir, 'storage-backend'), 'utf8')).toBe('zfs\n');

  checkStorageMarker(ctx.dataDir, 'zfs');

  expect(() => {
    checkStorageMarker(ctx.dataDir, 'xfs');
  }).toThrow('holds zfs storage');
});

test('it reads a data dir with imps and no marker as xfs', () => {
  using ctx = setupDataDir();

  mkdirSync(join(ctx.dataDir, 'imps', 'some-imp'), { recursive: true });

  expect(() => {
    checkStorageMarker(ctx.dataDir, 'zfs');
  }).toThrow('holds xfs storage, but IMP_STORAGE_BACKEND is zfs');

  checkStorageMarker(ctx.dataDir, 'xfs');

  expect(readFileSync(join(ctx.dataDir, 'storage-backend'), 'utf8')).toBe('xfs\n');
});
