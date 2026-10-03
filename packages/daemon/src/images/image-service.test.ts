import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config';
import { openDatabase } from '../db/open-database';
import { createStorageGate } from '../storage/storage-gate';
import { createXfsBackend } from '../storage/xfs-backend';
import { createImageService, planRootfs } from './image-service';

// These all fail before any docker command runs, so no docker is needed.
test('it refuses refs and build contexts that docker could read as flags', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);

  try {
    const db = await openDatabase(':memory:');

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db,
      storage: createXfsBackend({ dataDir }),
      storageGate: createStorageGate(),
      diskBudget: { withRoom: (_bytes, task) => task() },
    });

    for (const ref of ['--help', '-v/:/host', 'ubuntu --privileged', '']) {
      const failure = await images.addImage(ref, 'x').catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
      expect(String(failure)).toContain('invalid image reference');
    }

    const buildFailure = await images
      .buildImage('--file=/etc/passwd', 'x')
      .catch((error: unknown) => error);

    expect(buildFailure).toMatchObject({ code: 'BAD_REQUEST' });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('it refuses a build context that is not on the impd host', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);

  try {
    const db = await openDatabase(':memory:');

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db,
      storage: createXfsBackend({ dataDir }),
      storageGate: createStorageGate(),
      diskBudget: { withRoom: (_bytes, task) => task() },
    });

    const failure = await images
      .buildImage(`${dataDir}/no-such-dir`, 'x')
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(failure)).toContain('does not exist on the impd host');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a rootfs is its tree plus room to spare, in whole GiB, at least 4 GiB', () => {
  const GIB = 1024 ** 3;

  expect(planRootfs({ bytes: 300 * 1024 ** 2, inodes: 20_000 })).toEqual({
    bytes: 4 * GIB,
    inodes: null,
  });

  expect(planRootfs({ bytes: 5 * GIB, inodes: 90_000 })).toEqual({ bytes: 8 * GIB, inodes: null });

  // node_modules: many small files need more inodes than 16 KiB each gives
  expect(planRootfs({ bytes: GIB, inodes: 400_000 })).toEqual({ bytes: 4 * GIB, inodes: 800_000 });
});

test('a build context on the impd host with no Dockerfile is the client’s mistake', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-image-test-`);

  try {
    const db = await openDatabase(':memory:');

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db,
      storage: createXfsBackend({ dataDir }),
      storageGate: createStorageGate(),
      diskBudget: { withRoom: (_bytes, task) => task() },
    });

    const failure = await images.buildImage(dataDir, 'x').catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(failure)).toContain('there is no Dockerfile');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
