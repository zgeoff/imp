import { expect, mock, test } from 'bun:test';
import { buildStubTimeouts } from './build-stub-timeouts';

test('it records each timer’s delay as pending and fires none on its own', () => {
  const stub = buildStubTimeouts();
  const fire = mock();

  stub.startTimer(5000, fire);
  stub.startTimer(50, fire);

  expect(stub.timers).toStrictEqual([
    { ms: 5000, state: 'pending' },
    { ms: 50, state: 'pending' },
  ]);

  expect(fire).not.toHaveBeenCalled();
});

test('it marks a timer cancelled once the unit cancels it', () => {
  const stub = buildStubTimeouts();
  const cancel = stub.startTimer(5000, () => {});

  cancel();

  expect(stub.timers).toStrictEqual([{ ms: 5000, state: 'cancelled' }]);
});

test('it fires only the pending timers, once, when the test fires them', () => {
  const stub = buildStubTimeouts();
  const first = mock();
  const second = mock();
  const cancel = stub.startTimer(5000, first);

  stub.startTimer(5000, second);

  cancel();

  stub.firePending();
  stub.firePending();

  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();

  expect(stub.timers).toStrictEqual([
    { ms: 5000, state: 'cancelled' },
    { ms: 5000, state: 'fired' },
  ]);
});

test('it leaves a fired timer fired when the unit cancels it after', () => {
  const stub = buildStubTimeouts();
  const cancel = stub.startTimer(5000, () => {});

  stub.firePending();

  cancel();

  expect(stub.timers).toStrictEqual([{ ms: 5000, state: 'fired' }]);
});
