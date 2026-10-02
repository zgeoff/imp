import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config';
import {
  checkStorageMarker,
  createStorageBackend,
  writeStorageMarker,
} from './create-storage-backend';

const LIVE = {
  impIds: new Set<string>(),
  checkpointIds: new Set<string>(),
  imageDigests: new Set<string>(),
};

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
  writeStorageMarker(ctx.dataDir, 'zfs');

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
  writeStorageMarker(ctx.dataDir, 'xfs');

  expect(readFileSync(join(ctx.dataDir, 'storage-backend'), 'utf8')).toBe('xfs\n');
});

test('the marker is written only once start succeeds', async () => {
  using ctx = setupDataDir();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_STORAGE_BACKEND: 'zfs',
    IMP_ZFS_ROOT: 'tank/imp',
  });

  // no zfs here: start fails before it checks anything else
  const backend = createStorageBackend(config);

  const failure = await backend.start(LIVE).catch(String);

  expect(failure).toContain('zfs');
  expect(existsSync(join(ctx.dataDir, 'storage-backend'))).toBeFalse();

  const xfs = createStorageBackend(loadConfig({ IMP_DATA_DIR: ctx.dataDir }), 0);

  await xfs.start(LIVE);

  expect(readFileSync(join(ctx.dataDir, 'storage-backend'), 'utf8')).toBe('xfs\n');
});
