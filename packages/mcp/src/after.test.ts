import { expect, onTestFinished, test } from 'bun:test';
import { runAfter } from './after';

test('it fires after the delay', async () => {
  const fired = Promise.withResolvers<number>();
  const started = performance.now();

  const cancel = runAfter(20, () => {
    fired.resolve(performance.now() - started);
  });

  onTestFinished(cancel);

  const elapsedMs = await fired.promise;

  expect(elapsedMs).toBeGreaterThanOrEqual(19);
});

test('it fires only once', async () => {
  const firedAtMs: number[] = [];
  const started = performance.now();

  const cancel = runAfter(5, () => {
    firedAtMs.push(performance.now() - started);
  });

  onTestFinished(cancel);

  // a timer of four times the delay fires after a repeat of the first would
  // have fired three times
  const later = Promise.withResolvers<void>();

  const cancelLater = runAfter(20, () => {
    later.resolve();
  });

  onTestFinished(cancelLater);

  await later.promise;

  expect(firedAtMs).toHaveLength(1);
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
