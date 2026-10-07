import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { buildStubWait } from './build-stub-wait';

test('it records each wait with its length in the order they began', () => {
  const stub = buildStubWait();

  void stub.wait(30_000, new AbortController().signal);
  void stub.wait(2000, new AbortController().signal);
  expect(stub.calls.map((call) => call.ms)).toStrictEqual([30_000, 2000]);
});

test('it ends a wait when the test releases it', async () => {
  const stub = buildStubWait();
  const waited = stub.wait(30_000, new AbortController().signal);
  const [call] = stub.calls;

  invariant(call);

  call.release();

  await expect(waited).toResolve();
});

test('it ends a wait at once when its signal aborts', async () => {
  const stub = buildStubWait();

  const controller = new AbortController();

  const waited = stub.wait(30_000, controller.signal);

  controller.abort();

  await expect(waited).toResolve();
});

test('it leaves a wait open until it is released or aborted', async () => {
  const stub = buildStubWait();
  const waited = stub.wait(30_000, new AbortController().signal);

  const first = await Promise.race([waited.then(() => 'ended'), Promise.resolve('open')]);

  expect(first).toBe('open');
});
