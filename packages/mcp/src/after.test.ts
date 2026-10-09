import { expect, onTestFinished, test } from 'bun:test';
import { runAfter } from './after';

test('it fires once after the delay', async () => {
  const fired = Promise.withResolvers<number>();
  const started = performance.now();

  const cancel = runAfter(20, () => {
    fired.resolve(performance.now() - started);
  });

  onTestFinished(cancel);

  const elapsedMs = await fired.promise;

  expect(elapsedMs).toBeGreaterThanOrEqual(19);
});

test('it never fires once cancelled', async () => {
  const calls: string[] = [];

  const cancel = runAfter(1, () => {
    calls.push('cancelled');
  });

  cancel();

  // a later timer of the same delay fires after the cancelled one would have
  const later = Promise.withResolvers<void>();

  const cancelLater = runAfter(5, () => {
    later.resolve();
  });

  onTestFinished(cancelLater);

  await later.promise;

  expect(calls).toStrictEqual([]);
});
