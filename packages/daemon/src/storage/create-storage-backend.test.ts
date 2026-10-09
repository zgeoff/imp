import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { buildStubZfs } from '../test-utils/build-stub-zfs';
import {
  checkStorageMarker,
  createStorageBackend,
  writeStorageMarker,
} from './create-storage-backend';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'impd-marker-test-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  return { dataDir };
}

test('#writeStorageMarker marks a new data dir with the backend that wrote it', async () => {
  const ctx = await setupTest();

  writeStorageMarker(ctx.dataDir, 'zfs');

  expect(readFileSync(join(ctx.dataDir, 'storage-backend'), 'utf8')).toBe('zfs\n');
});

test('#writeStorageMarker keeps a marker that is already there', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dataDir, 'storage-backend'), 'xfs\n');
  writeStorageMarker(ctx.dataDir, 'zfs');

  expect(readFileSync(join(ctx.dataDir, 'storage-backend'), 'utf8')).toBe('xfs\n');
});

test('#checkStorageMarker accepts a data dir its own backend marked', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dataDir, 'storage-backend'), 'zfs\n');

  expect(() => {
    checkStorageMarker(ctx.dataDir, 'zfs');
  }).not.toThrow();
});

test('#checkStorageMarker refuses a data dir another backend marked', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dataDir, 'storage-backend'), 'zfs\n');

  expect(() => {
    checkStorageMarker(ctx.dataDir, 'xfs');
  }).toThrowWithMessage(
    Error,
    `${ctx.dataDir} holds zfs storage, but IMP_STORAGE_BACKEND is xfs; moving imps between backends is not supported`,
  );
});

test('#checkStorageMarker reads a data dir with imps and no marker as xfs', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'imps', 'some-imp'), { recursive: true });

  expect(() => {
    checkStorageMarker(ctx.dataDir, 'zfs');
  }).toThrowWithMessage(Error, /holds xfs storage, but IMP_STORAGE_BACKEND is zfs/);
});

test('#checkStorageMarker accepts a data dir with imps and no marker for xfs', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'imps', 'some-imp'), { recursive: true });

  expect(() => {
    checkStorageMarker(ctx.dataDir, 'xfs');
  }).not.toThrow();
});

test.each(['xfs', 'zfs'] as const)(
  '#checkStorageMarker accepts a data dir with no imps dir and no marker for %s',
  async (kind) => {
    const ctx = await setupTest();

    expect(() => {
      checkStorageMarker(ctx.dataDir, kind);
    }).not.toThrow();
  },
);

test.each(['xfs', 'zfs'] as const)(
  '#checkStorageMarker accepts an empty data dir with no marker for %s',
  async (kind) => {
    const ctx = await setupTest();

    await mkdir(join(ctx.dataDir, 'imps'));

    expect(() => {
      checkStorageMarker(ctx.dataDir, kind);
    }).not.toThrow();
  },
);

test('#createStorageBackend refuses a data dir another backend marked', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dataDir, 'storage-backend'), 'xfs\n');

  expect(() =>
    createStorageBackend(
      loadConfig({
        IMP_DATA_DIR: ctx.dataDir,
        IMP_STORAGE_BACKEND: 'zfs',
        IMP_ZFS_ROOT: 'tank/imp',
      }),
    ),
  ).toThrowWithMessage(Error, /holds xfs storage, but IMP_STORAGE_BACKEND is zfs/);
});

test('#createStorageBackend refuses the zfs backend with no root dataset', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_STORAGE_BACKEND: 'zfs',
    IMP_ZFS_ROOT: 'tank/imp',
  });

  // loadConfig refuses this itself; the backend checks again for a caller
  // that builds its config another way
  expect(() => createStorageBackend({ ...config, zfsRoot: null })).toThrowWithMessage(
    Error,
    'IMP_STORAGE_BACKEND=zfs needs IMP_ZFS_ROOT',
  );
});

test('#createStorageBackend writes no marker when start fails', async () => {
  const ctx = await setupTest();

  const zfs = buildStubZfs({ root: 'tank/imp', rootDir: ctx.dataDir });

  const backend = createStorageBackend(
    loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_STORAGE_BACKEND: 'zfs', IMP_ZFS_ROOT: 'tank/imp' }),
    {
      zfs: {
        run: zfs.run,
        streams: zfs.streams,
        readMounts: zfs.readMounts,
        readModuleVersion: () => null,
        log: () => {},
      },
    },
  );

  const started = backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  expect(started).rejects.toThrowWithMessage(
    Error,
    'zfs: the kernel module is not loaded (no /sys/module/zfs/version)',
  );

  expect(existsSync(join(ctx.dataDir, 'storage-backend'))).toBeFalse();
});

test('#createStorageBackend marks the data dir xfs once start succeeds', async () => {
  const ctx = await setupTest();

  // a temp dir may sit on a tmpfs, which takes no reserve file
  const backend = createStorageBackend(loadConfig({ IMP_DATA_DIR: ctx.dataDir }), {
    xfsReserveFileBytes: 0,
  });

  await backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(readFileSync(join(ctx.dataDir, 'storage-backend'), 'utf8')).toBe('xfs\n');
});

test('#createStorageBackend accepts a data dir with imps and no marker, and marks it xfs', async () => {
  const ctx = await setupTest();

  // a data dir from before the marker: an imp's disk and nothing else
  await mkdir(join(ctx.dataDir, 'imps', 'some-imp'), { recursive: true });

  writeFileSync(join(ctx.dataDir, 'imps', 'some-imp', 'disk.ext4'), '');

  const backend = createStorageBackend(loadConfig({ IMP_DATA_DIR: ctx.dataDir }), {
    xfsReserveFileBytes: 0,
  });

  await backend.start({
    impIds: new Set(['some-imp']),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  expect(readFileSync(join(ctx.dataDir, 'storage-backend'), 'utf8')).toBe('xfs\n');
});

test('#createStorageBackend marks the data dir zfs once start succeeds', async () => {
  const ctx = await setupTest();

  const zfs = buildStubZfs({ root: 'tank/imp', rootDir: ctx.dataDir });

  const backend = createStorageBackend(
    loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_STORAGE_BACKEND: 'zfs', IMP_ZFS_ROOT: 'tank/imp' }),
    {
      zfs: {
        run: zfs.run,
        streams: zfs.streams,
        readMounts: zfs.readMounts,
        readModuleVersion: () => '2.2.2-0ubuntu9',
        log: () => {},
      },
    },
  );

  await backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(readFileSync(join(ctx.dataDir, 'storage-backend'), 'utf8')).toBe('zfs\n');
});
