import { expect, mock, test } from 'bun:test';
import { buildStubRepeat } from './build-stub-repeat';

test('it runs a repeat once for each tick of its interval', () => {
  const stub = buildStubRepeat();
  const tick = mock(() => {});

  stub.repeat(20, tick);
  stub.tick(20);
  stub.tick(20);

  expect(tick).toHaveBeenCalledTimes(2);
});

test('it never runs a repeat on a tick of another interval', () => {
  const stub = buildStubRepeat();
  const tick = mock(() => {});

  stub.repeat(20, tick);
  stub.tick(30);

  expect(tick).not.toHaveBeenCalled();
});

test('it never runs a repeat after its stop', () => {
  const stub = buildStubRepeat();
  const tick = mock(() => {});
  const stop = stub.repeat(20, tick);

  stop();

  stub.tick(20);

  expect(tick).not.toHaveBeenCalled();
});

test('it counts the repeats of an interval that still run', () => {
  const stub = buildStubRepeat();
  const stop = stub.repeat(20, () => {});

  stub.repeat(20, () => {});
  stub.repeat(30, () => {});

  stop();

  expect(stub.countRunning(20)).toBe(1);
});
