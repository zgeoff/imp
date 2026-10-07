import { expect, mock, test } from 'bun:test';
import { buildStubSignals } from './build-stub-signals';

test('it hands a signal to each listener on it', () => {
  const stub = buildStubSignals();
  const listener = mock<() => void>();

  stub.signals.on('SIGINT', listener);
  stub.send('SIGINT');

  expect(listener).toHaveBeenCalledOnce();
});

test('it never hands a signal to a listener on another one', () => {
  const stub = buildStubSignals();
  const listener = mock<() => void>();

  stub.signals.on('SIGTERM', listener);
  stub.send('SIGINT');

  expect(listener).not.toHaveBeenCalled();
});

test('it stops handing a signal to a listener taken off', () => {
  const stub = buildStubSignals();
  const listener = mock<() => void>();

  stub.signals.on('SIGINT', listener);
  stub.signals.off('SIGINT', listener);
  stub.send('SIGINT');

  expect(listener).not.toHaveBeenCalled();
});

test('it names the signals that still have a listener', () => {
  const stub = buildStubSignals();
  const listener = mock<() => void>();

  stub.signals.on('SIGINT', listener);
  stub.signals.on('SIGHUP', listener);
  stub.signals.off('SIGINT', listener);

  expect(stub.listening()).toStrictEqual(['SIGHUP']);
});
