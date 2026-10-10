import { expect, mock, test } from 'bun:test';
import { buildStubTickerTimer } from './build-stub-ticker-timer';

test('it runs a scheduled run only when the test fires its label', async () => {
  const stub = buildStubTickerTimer();
  const run = mock(() => Promise.resolve());

  stub.timer('sweep', run, 1000);

  await stub.fire('sweep');

  expect(run).toHaveBeenCalledOnce();
});

test('it runs nothing on its own', () => {
  const stub = buildStubTickerTimer();
  const run = mock(() => Promise.resolve());

  stub.timer('sweep', run, 0);

  expect(run).not.toHaveBeenCalled();
});

test('it waits for the fired run to finish', async () => {
  const stub = buildStubTickerTimer();
  const steps: string[] = [];

  stub.timer(
    'sweep',
    async () => {
      await Promise.resolve();

      steps.push('ran');
    },
    1000,
  );

  await stub.fire('sweep');

  expect(steps).toStrictEqual(['ran']);
});

test('it fires a scheduled run once', async () => {
  const stub = buildStubTickerTimer();

  stub.timer('sweep', () => Promise.resolve(), 1000);

  await stub.fire('sweep');

  expect(stub.fire('sweep')).rejects.toThrowWithMessage(
    Error,
    'nothing waits on a timer named sweep',
  );
});

test('it drops a cancelled run', () => {
  const stub = buildStubTickerTimer();
  const cancel = stub.timer('sweep', () => Promise.resolve(), 1000);

  cancel();

  expect(stub.readDelays()).toStrictEqual({});
});

test('it keeps the other runs when one is cancelled', () => {
  const stub = buildStubTickerTimer();
  const cancel = stub.timer('sweep', () => Promise.resolve(), 1000);

  stub.timer('renewal', () => Promise.resolve(), 600_000);

  cancel();

  expect(stub.readDelays()).toStrictEqual({ renewal: 600_000 });
});

test('it keeps a newer run of the label when an older one is cancelled', () => {
  const stub = buildStubTickerTimer();
  const cancel = stub.timer('sweep', () => Promise.resolve(), 1000);

  stub.timer('sweep', () => Promise.resolve(), 2000);

  cancel();

  expect(stub.readDelays()).toStrictEqual({ sweep: 2000 });
});

test('it refuses to fire a label nothing waits on', () => {
  const stub = buildStubTickerTimer();

  expect(stub.fire('sweep')).rejects.toThrowWithMessage(
    Error,
    'nothing waits on a timer named sweep',
  );
});

test('it reports the delay of each pending run', () => {
  const stub = buildStubTickerTimer();

  stub.timer('sweep', () => Promise.resolve(), 1000);
  stub.timer('renewal', () => Promise.resolve(), 600_000);

  expect(stub.readDelays()).toStrictEqual({ sweep: 1000, renewal: 600_000 });
});
