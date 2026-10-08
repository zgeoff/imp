import { expect, test } from 'bun:test';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createCheckpoint, findCheckpoint, listCheckpoints, removeCheckpoint } from './checkpoints';
import { createImage } from './images';
import { createImp, removeImp } from './imps';

async function setupImp() {
  const ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  return Object.assign(ctx, { imp });
}

test('it lists checkpoints newest first', async () => {
  const ctx = await setupImp();

  const first = await createCheckpoint(ctx.db, {
    id: 'cp-1',
    impId: ctx.imp.id,
    label: 'one',
    sizeBytes: 10,
  });

  const second = await createCheckpoint(ctx.db, {
    id: 'cp-2',
    impId: ctx.imp.id,
    label: null,
    sizeBytes: null,
  });

  const checkpoints = await listCheckpoints(ctx.db, ctx.imp.id);

  expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual([second.id, first.id]);
});

test('it finds a checkpoint by id or by label', async () => {
  const ctx = await setupImp();

  const checkpoint = await createCheckpoint(ctx.db, {
    id: 'cp-3',
    impId: ctx.imp.id,
    label: 'clean',
    sizeBytes: 1,
  });

  const byId = await findCheckpoint(ctx.db, ctx.imp.id, checkpoint.id);
  const byLabel = await findCheckpoint(ctx.db, ctx.imp.id, 'clean');
  const missing = await findCheckpoint(ctx.db, ctx.imp.id, 'dirty');

  expect(byId).toEqual(checkpoint);
  expect(byLabel).toEqual(checkpoint);
  expect(missing).toBeUndefined();
});

test('it rejects a duplicate label on one imp', async () => {
  const ctx = await setupImp();

  const checkpoint = { impId: ctx.imp.id, label: 'clean', sizeBytes: 1 };

  await createCheckpoint(ctx.db, { id: 'cp-1', ...checkpoint });

  expect(createCheckpoint(ctx.db, { id: 'cp-2', ...checkpoint })).rejects.toThrowWithMessage(
    Error,
    /UNIQUE constraint failed/u,
  );
});

test('it rejects a checkpoint for an imp that does not exist', async () => {
  const ctx = await setupImp();

  const orphan = { id: 'cp-x', impId: 'missing', label: null, sizeBytes: null };

  expect(createCheckpoint(ctx.db, orphan)).rejects.toThrowWithMessage(
    Error,
    /FOREIGN KEY constraint failed/u,
  );
});

test('it removes a checkpoint, and removing the imp removes the rest', async () => {
  const ctx = await setupImp();

  const a = await createCheckpoint(ctx.db, {
    id: 'cp-4',
    impId: ctx.imp.id,
    label: 'a',
    sizeBytes: 1,
  });

  await createCheckpoint(ctx.db, { id: 'cp-5', impId: ctx.imp.id, label: 'b', sizeBytes: 1 });

  const removed = await removeCheckpoint(ctx.db, a.id);
  const remaining = await listCheckpoints(ctx.db, ctx.imp.id);

  expect(removed).toBe(true);
  expect(remaining).toHaveLength(1);

  await removeImp(ctx.db, ctx.imp.id);

  const cascaded = await listCheckpoints(ctx.db, ctx.imp.id);

  expect(cascaded).toHaveLength(0);
});
