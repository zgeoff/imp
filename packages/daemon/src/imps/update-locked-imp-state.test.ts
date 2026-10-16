import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@impz/test-utils/invariant';
import { createImp, findImpById, updateImpState } from '../db/imps';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createImpContext } from './imp-context';
import { createImpLock } from './imp-lock';
import { createImpTest } from './test-imps';
import { updateLockedImpState } from './update-locked-imp-state';

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

test('it moves a creating imp to stopped', async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: ctx.image.id }));

  const stopped = await ctx.lock.withImpId(imp.id, (locked) => {
    invariant(locked);

    return updateLockedImpState(ctx.db, locked, { reason: 'stopped', state: 'stopped' });
  });

  expect(stopped.state).toBe('stopped');
});

test('it refuses a move the lifecycle table does not list', async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: ctx.image.id }));

  await updateImpState(ctx.db, imp.id, { reason: 'stopped', state: 'stopped' });

  const refusal = ctx.lock.withImpId(imp.id, (locked) => {
    invariant(locked);

    return updateLockedImpState(ctx.db, locked, { reason: 'slept', state: 'sleeping' });
  });

  expect(refusal).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'stopped', allowed: ['running'] },
  });
});

test("it refuses a record read without the imp's lock", async () => {
  const ctx = await setupTest();
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: ctx.image.id }));

  // @ts-expect-error a plain record is no LockedImp: the type refuses it too
  const refusal = updateLockedImpState(ctx.db, imp, { reason: 'stopped', state: 'stopped' });

  expect(refusal).rejects.toThrow(/a state write needs the imp's lock/);

  const unchanged = await findImpById(ctx.db, imp.id);

  expect(unchanged?.state).toBe('creating');
});
