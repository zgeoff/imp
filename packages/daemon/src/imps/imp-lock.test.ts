import { expect, mock, onTestFinished, test } from 'bun:test';
import { createImp, updateImpMove } from '../db/imps';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createImpContext } from './imp-context';
import { createImpLock } from './imp-lock';
import { createImpTest } from './test-imps';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, {});

  // every imp row names an image
  const image = await harness.createTestImage('ubuntu');

  const context = createImpContext({
    config: harness.config,
    db: harness.db,
    images: harness.images,

    // the lock never brings a tap up
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    vms: harness.fake.startGeneration(),
    storage: harness.storage,
    identity: harness.readIdentity(),
    log: harness.log,
    storageGate: harness.storageGate,
  });

  return { db: harness.db, image, lock: createImpLock(context) };
}

test('#withImp refuses an imp whose move is in flight', async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ name: 'dev', imageId: ctx.image.id }));

  await updateImpMove(ctx.db, imp.id, 'sending');

  const action = mock(() => Promise.resolve());

  expect(ctx.lock.withImp('dev', action)).rejects.toMatchObject({ code: 'MOVING' });
});

test('#withImpId refuses an imp whose move is in flight', async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: ctx.image.id }));

  await updateImpMove(ctx.db, imp.id, 'sending');

  const action = mock(() => Promise.resolve());
  const refusal = ctx.lock.withImpId(imp.id, action);

  expect(refusal).rejects.toMatchObject({ code: 'MOVING' });
  expect(action).not.toHaveBeenCalled();
});

test("#withImpId runs the move's own call on a moving imp", async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: ctx.image.id }));

  await updateImpMove(ctx.db, imp.id, 'sending');

  const seen = await ctx.lock.withImpId(imp.id, (locked) => Promise.resolve(locked?.moveState), {
    isMove: true,
  });

  expect(seen).toBe('sending');
});

test('#withImpId runs on an imp that is not moving', async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: ctx.image.id }));
  const seen = await ctx.lock.withImpId(imp.id, (locked) => Promise.resolve(locked?.id));

  expect(seen).toBe(imp.id);
});

test('#tryWithImpId refuses an imp whose move is in flight', async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: ctx.image.id }));

  await updateImpMove(ctx.db, imp.id, 'receiving');

  const action = mock(() => Promise.resolve());

  const result = await ctx.lock.tryWithImpId(imp.id, action);

  expect(result).toStrictEqual({ ran: false });
  expect(action).not.toHaveBeenCalled();
});

test("#tryWithImpId runs the move's own call on a moving imp", async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: ctx.image.id }));

  await updateImpMove(ctx.db, imp.id, 'receiving');

  const result = await ctx.lock.tryWithImpId(
    imp.id,
    (locked) => Promise.resolve(locked?.moveState),
    { isMove: true },
  );

  expect(result).toStrictEqual({ ran: true, value: 'receiving' });
});

test('#tryWithImpId runs on an imp that is not moving', async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: ctx.image.id }));
  const result = await ctx.lock.tryWithImpId(imp.id, (locked) => Promise.resolve(locked?.id));

  expect(result).toStrictEqual({ ran: true, value: imp.id });
});
