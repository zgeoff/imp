import { expect, mock, test } from 'bun:test';
import { buildStubAfter } from './build-stub-after';

test('it fires a timer once, however often its delay is fired', () => {
  const stub = buildStubAfter();
  const fire = mock(() => {});

  stub.after(20, fire);
  stub.fire(20);
  stub.fire(20);

  expect(fire).toHaveBeenCalledOnce();
});

test('it never fires a timer when another delay is fired', () => {
  const stub = buildStubAfter();
  const fire = mock(() => {});

  stub.after(20, fire);
  stub.fire(30);

  expect(fire).not.toHaveBeenCalled();
});

test('it never fires a timer after its cancel', () => {
  const stub = buildStubAfter();
  const fire = mock(() => {});
  const cancel = stub.after(20, fire);

  cancel();

  stub.fire(20);

  expect(fire).not.toHaveBeenCalled();
});

test('it counts the timers of a delay that still wait', () => {
  const stub = buildStubAfter();
  const cancel = stub.after(20, () => {});

  stub.after(20, () => {});
  stub.after(20, () => {});
  stub.after(30, () => {});

  cancel();

  stub.fire(30);

  expect(stub.countPending(20)).toBe(2);
});

test('it counts no timer once its delay is fired', () => {
  const stub = buildStubAfter();

  stub.after(20, () => {});
  stub.fire(20);

  expect(stub.countPending(20)).toBe(0);
});
