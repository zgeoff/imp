import { expect, mock, test } from 'bun:test';
import { buildStubBackoffClock } from './build-stub-backoff-clock';

test('it ends each wait at once and records its delay', async () => {
  const backoff = buildStubBackoffClock({ at: 1, onWait: () => {} });

  await backoff.wait(1000);
  await backoff.wait(2000);

  expect(backoff.delays).toStrictEqual([1000, 2000]);
});

test('it moves the clock on by each wait and each advance', async () => {
  const backoff = buildStubBackoffClock({ at: 1, onWait: () => {} });

  await backoff.wait(1000);

  backoff.advance(20_000);

  expect(backoff.now()).toBe(21_000);
});

test('it runs the hook during the numbered wait only', async () => {
  const onWait = mock<() => void>();
  const backoff = buildStubBackoffClock({ at: 2, onWait });

  await backoff.wait(1000);

  const before = onWait.mock.calls.length;

  await backoff.wait(2000);
  await backoff.wait(4000);

  expect(before).toBe(0);
  expect(onWait).toHaveBeenCalledOnce();
});

test('it runs the hook before that wait ends', async () => {
  const order: string[] = [];

  const backoff = buildStubBackoffClock({
    at: 1,
    onWait: () => {
      order.push('hook');
    },
  });

  await backoff.wait(1000);

  order.push('ended');

  expect(order).toStrictEqual(['hook', 'ended']);
});
