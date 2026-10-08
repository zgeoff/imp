import { expect, mock, onTestFinished, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { startInterval } from './start-interval';

test('it runs its callback again on each interval', async () => {
  const run = mock();

  const stop = startInterval(() => {
    run();
  }, 5);

  onTestFinished(stop);

  await waitFor(() => {
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

test('it runs its callback no more once stopped', async () => {
  const run = mock();

  const stop = startInterval(() => {
    run();
  }, 5);

  onTestFinished(stop);

  await waitFor(() => {
    expect(run).toHaveBeenCalled();
  });

  stop();

  const runs = run.mock.calls.length;

  // a second interval of the same length, which runs three times meanwhile
  const fence = mock();

  const stopFence = startInterval(() => {
    fence();
  }, 5);

  onTestFinished(stopFence);

  await waitFor(() => {
    expect(fence.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  expect(run).toHaveBeenCalledTimes(runs);
});
