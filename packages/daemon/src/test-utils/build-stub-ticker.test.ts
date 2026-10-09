import { expect, mock, test } from 'bun:test';
import { buildStubTicker } from './build-stub-ticker';

test('it runs a task only when the test fires its label', async () => {
  const ticker = buildStubTicker();
  const task = mock(() => Promise.resolve());

  ticker.startTicker('sweep', 1000, task, () => {});

  await ticker.fire('sweep');

  expect(task).toHaveBeenCalledOnce();
});

test('it runs no task on its own', () => {
  const ticker = buildStubTicker();
  const task = mock(() => Promise.resolve());

  ticker.startTicker('sweep', 0, task, () => {});

  expect(task).not.toHaveBeenCalled();
});

test('it logs a failed task as startTicker does', async () => {
  const ticker = buildStubTicker();
  const logs: string[] = [];

  ticker.startTicker(
    'sweep',
    1000,
    () => Promise.reject(new Error('disk full')),
    (message) => {
      logs.push(message);
    },
  );

  await ticker.fire('sweep');

  expect(logs).toStrictEqual(['impd: sweep: disk full']);
});

test('it refuses to fire a ticker that was stopped', async () => {
  const ticker = buildStubTicker();

  const started = ticker.startTicker(
    'sweep',
    1000,
    () => Promise.resolve(),
    () => {},
  );

  await started.stop();

  expect(ticker.fire('sweep')).rejects.toThrowWithMessage(Error, 'no ticker named sweep runs');
});

test('it refuses to fire a label no ticker has', () => {
  const ticker = buildStubTicker();

  expect(ticker.fire('sweep')).rejects.toThrowWithMessage(Error, 'no ticker named sweep runs');
});

test('it reports the interval each ticker started with', () => {
  const ticker = buildStubTicker();

  ticker.startTicker(
    'sweep',
    1000,
    () => Promise.resolve(),
    () => {},
  );

  ticker.startTicker(
    'renewal',
    600_000,
    () => Promise.resolve(),
    () => {},
  );

  expect(ticker.readIntervals()).toStrictEqual({ sweep: 1000, renewal: 600_000 });
});
