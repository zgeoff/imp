import { expect, onTestFinished, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { createImpClient } from '@impz/client';
import { createImage } from '@impz/daemon/src/db/images';
import { buildImagePaths } from '@impz/daemon/src/storage/data-layout';
import { buildMockNewImage } from '@impz/daemon/src/test-utils/build-mock-new-image';
import { invariant } from '@impz/test-utils/invariant';
import { startImpdHost } from './start-impd-host';

// the stack the host's releases go into, disposed when the test ends
function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it serves impd on its loopback port to its root token', async () => {
  const ctx = setupTest();

  const host = await startImpdHost(ctx.stack, { env: {} });
  const info = await createImpClient({ url: host.url, token: host.rootToken }).system.info();

  expect(info.impCount).toBe(0);
});

test('it refuses a token other than its root token', async () => {
  const ctx = setupTest();

  const host = await startImpdHost(ctx.stack, { env: {} });

  const reading = createImpClient({ url: host.url, token: 'other-token' }).system.info();

  expect(reading).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});

test('it boots impd on the settings it is given', async () => {
  const ctx = setupTest();

  const host = await startImpdHost(ctx.stack, { env: { IMP_RAM_BUDGET_MIB: '4096' } });
  const info = await host.client.system.info();

  expect(info.ramBudgetMib).toBe(4096);
});

test('it reports the KSM saving the test sets for an awake imp', async () => {
  const ctx = setupTest();

  const host = await startImpdHost(ctx.stack, { env: { IMP_KSM: '1' } });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(host.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(host.db, image);

  await host.client.imps.create({ name: 'web', image: 'base' });

  host.ksm.profitMib = 16_000;

  const info = await host.client.system.info();

  invariant(info.ksm);

  expect(info.ksm.headroomMib).toBe(16_000);
});

test('it closes its listener and removes its data dir with the stack', async () => {
  const ctx = setupTest();

  const host = await startImpdHost(ctx.stack, { env: {} });

  await ctx.stack.disposeAsync();

  expect(fetch(`${host.url}/health`)).rejects.toMatchObject({ code: 'ConnectionRefused' });
  expect(stat(host.dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
});
