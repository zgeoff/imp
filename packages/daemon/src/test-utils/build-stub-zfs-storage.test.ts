import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubZfsStorage } from './build-stub-zfs-storage';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'stub-zfs-storage-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  return { dataDir };
}

test('it refuses to hand back a pool before the storage is made', () => {
  expect(() => buildStubZfsStorage('tank/imp').readPool()).toThrowWithMessage(
    Error,
    'no pool: the storage was never made',
  );
});

test('it makes the storage on a pool under the root it was given', async () => {
  const ctx = await setupTest();

  const zfs = buildStubZfsStorage('tank/imp');
  const storage = zfs.createStorage(ctx.dataDir);

  await storage.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(storage.kind).toBe('zfs');
  expect(zfs.readPool().listDatasets()).toContain('tank/imp');
});

test('it writes a disk file where a clone of an image lands', async () => {
  const ctx = await setupTest();

  const zfs = buildStubZfsStorage('tank/imp');
  const storage = zfs.createStorage(ctx.dataDir);

  await storage.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await storage.createImage('sha256:ubuntu', () => Promise.resolve());

  await storage.createImpDisk('8d3c3b1e-4c1a-4b8e-9f00-000000000001', {
    kind: 'image',
    digest: 'sha256:ubuntu',
  });

  expect(
    readFileSync(storage.resolveImpPaths('8d3c3b1e-4c1a-4b8e-9f00-000000000001').disk, 'utf8'),
  ).toBe('disk');
});

test('it keeps the file the backend writes for an empty disk', async () => {
  const ctx = await setupTest();

  const zfs = buildStubZfsStorage('tank/imp');
  const storage = zfs.createStorage(ctx.dataDir);

  await storage.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await storage.createImpDisk('8d3c3b1e-4c1a-4b8e-9f00-000000000001', { kind: 'empty' });

  expect(
    readFileSync(storage.resolveImpPaths('8d3c3b1e-4c1a-4b8e-9f00-000000000001').disk, 'utf8'),
  ).toBe('');
});
