import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findImageByName } from '../db/images';
import { createBuilderImage } from './create-builder-image';
import { createTestDatabase } from './create-test-database';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'builder-image-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const database = await createTestDatabase();

  return { dataDir, db: database.db };
}

test('it writes the builders image row for the reference', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: 'ghcr.io/zgeoff/imp-base:1' });

  const row = await findImageByName(ctx.db, 'imp-builder');

  expect(row).toMatchObject({
    name: 'imp-builder',
    ref: 'ghcr.io/zgeoff/imp-base:1',

    // sha256sum of the rootfs it writes, `rootfs`
    digest: 'sha256:3c47ef972d531d524daa15fa33dd885dd23de6221bbd10a29eb42ecfcf2ef422',
    source: 'oci',
    sizeBytes: 6,
  });
});

test('it writes the rootfs the builder imps boot from', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: 'ghcr.io/zgeoff/imp-base:1' });

  const rootfs = join(
    ctx.dataDir,
    'images',
    '3c47ef972d531d524daa15fa33dd885dd23de6221bbd10a29eb42ecfcf2ef422',
    'rootfs.ext4',
  );

  const written = await Bun.file(rootfs).text();

  expect(written).toBe('rootfs');
});

test('it returns the row it wrote', async () => {
  const ctx = await setupTest();

  const image = await createBuilderImage({
    db: ctx.db,
    dataDir: ctx.dataDir,
    ref: 'ghcr.io/zgeoff/imp-base:2',
  });

  const row = await findImageByName(ctx.db, 'imp-builder');

  expect(row).toStrictEqual(image);
});
