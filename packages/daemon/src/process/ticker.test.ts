import { expect, mock, onTestFinished, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { buildStubTickerTimer } from '../test-utils/build-stub-ticker-timer';
import { startTicker } from './ticker';

test('it waits one interval before the first run', () => {
  const stub = buildStubTickerTimer();
  const task = mock(() => Promise.resolve());
  const ticker = startTicker('sweep', 30_000, task, () => {}, stub.timer);

  onTestFinished(() => ticker.stop());

  expect(task).not.toHaveBeenCalled();
  expect(stub.readDelays()).toStrictEqual({ sweep: 30_000 });
});

test('it runs the task when the interval passes', async () => {
  const stub = buildStubTickerTimer();
  const task = mock(() => Promise.resolve());
  const ticker = startTicker('sweep', 30_000, task, () => {}, stub.timer);

  onTestFinished(() => ticker.stop());

  await stub.fire('sweep');

  expect(task).toHaveBeenCalledOnce();
});

test('it schedules the next run once a run ends', async () => {
  const stub = buildStubTickerTimer();

  const ticker = startTicker(
    'sweep',
    30_000,
    () => Promise.resolve(),
    () => {},
    stub.timer,
  );

  onTestFinished(() => ticker.stop());

  await stub.fire('sweep');

  expect(stub.readDelays()).toStrictEqual({ sweep: 30_000 });
});

test('it logs a failed run with its label', async () => {
  const stub = buildStubTickerTimer();
  const logs: string[] = [];

  const ticker = startTicker(
    'sweep',
    30_000,
    () => Promise.reject(new Error('disk full')),
    (message) => {
      logs.push(message);
    },
    stub.timer,
  );

  onTestFinished(() => ticker.stop());

  await stub.fire('sweep');

  expect(logs).toStrictEqual(['impd: sweep: disk full']);
});

test('it runs again after a failed run', async () => {
  const stub = buildStubTickerTimer();
  const task = mock(() => Promise.reject(new Error('disk full')));
  const ticker = startTicker('sweep', 30_000, task, () => {}, stub.timer);

  onTestFinished(() => ticker.stop());

  await stub.fire('sweep');
  await stub.fire('sweep');

  expect(task).toHaveBeenCalledTimes(2);
});

test('it schedules nothing more once stopped', async () => {
  const stub = buildStubTickerTimer();

  const ticker = startTicker(
    'sweep',
    30_000,
    () => Promise.resolve(),
    () => {},
    stub.timer,
  );

  await ticker.stop();

  expect(stub.readDelays()).toStrictEqual({});
});

test('it waits for a running task when stopped', async () => {
  const stub = buildStubTickerTimer();
  const release = Promise.withResolvers<void>();
  const steps: string[] = [];

  const ticker = startTicker(
    'sweep',
    30_000,
    async () => {
      steps.push('started');

      await release.promise;

      steps.push('finished');
    },
    () => {},
    stub.timer,
  );

  const fired = stub.fire('sweep');

  const stopped = (async () => {
    await ticker.stop();

    steps.push('stopped');
  })();

  // every pending callback runs first, so a stop that did not wait ends here
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  steps.push('released');
  release.resolve();

  await Promise.all([fired, stopped]);

  expect(steps).toStrictEqual(['started', 'released', 'finished', 'stopped']);
});

test('it runs on the runtime timers by default', async () => {
  const task = mock(() => Promise.resolve());
  const ticker = startTicker('sweep', 1, task, () => {});

  onTestFinished(() => ticker.stop());

  await waitFor(() => {
    expect(task).toHaveBeenCalled();
  });
});
