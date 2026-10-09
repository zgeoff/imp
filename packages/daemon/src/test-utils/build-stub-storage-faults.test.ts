import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubStorageFaults } from './build-stub-storage-faults';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'storage-faults-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const backend = createXfsBackend({
    dataDir,
    cloneFile: (source, target) => copyFile(source, target),
  });

  return { dataDir, backend };
}

test('it opens a move source through the wrapped backend while no fault is set', async () => {
  const ctx = await setupTest();

  const storage = buildStubStorageFaults().wrap(ctx.backend);

  const source = await storage.openMoveSource('imp-1', [], 'files');

  expect(source).toMatchObject({
    kind: 'files',
    checkpointPaths: [],
    diskPath: join(ctx.dataDir, 'imps', 'imp-1', 'disk.ext4'),
  });
});

test('it rejects the next move source open with the error a fault sets', async () => {
  const ctx = await setupTest();

  const faults = buildStubStorageFaults();
  const storage = faults.wrap(ctx.backend);

  faults.failOnce('openMoveSource', new Error('the disk is unreadable'));

  expect(storage.openMoveSource('imp-1', [], 'files')).rejects.toThrowWithMessage(
    Error,
    'the disk is unreadable',
  );
});

test('it fails only one move source open for each fault', async () => {
  const ctx = await setupTest();

  const faults = buildStubStorageFaults();
  const storage = faults.wrap(ctx.backend);

  faults.failOnce('openMoveSource', new Error('the disk is unreadable'));

  expect(storage.openMoveSource('imp-1', [], 'files')).rejects.toThrow('the disk is unreadable');

  const source = await storage.openMoveSource('imp-1', [], 'files');

  expect(source.kind).toBe('files');
});

test("it leaves the wrapped backend's other calls as they are", async () => {
  const ctx = await setupTest();

  const storage = buildStubStorageFaults().wrap(ctx.backend);

  expect(storage.resolveImpPaths('imp-1')).toStrictEqual(ctx.backend.resolveImpPaths('imp-1'));
});
