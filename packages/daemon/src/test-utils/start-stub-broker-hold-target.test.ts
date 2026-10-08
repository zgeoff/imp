import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { waitFor } from '@imp/test-utils/wait-for';
import { startStubBrokerHoldTarget } from './start-stub-broker-hold-target';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it sends nothing on a connection it holds', async () => {
  const ctx = setupTest();

  const target = await startStubBrokerHoldTarget(ctx.stack);

  const connected = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port: target.port }, connected.resolve);

  ctx.stack.defer(() => {
    socket.destroy();
  });

  await connected.promise;

  await waitFor(() => {
    expect(target.held.size).toBe(1);
  });

  expect(socket.bytesRead).toBe(0);
});

test('it keeps a connection it holds open', async () => {
  const ctx = setupTest();

  const target = await startStubBrokerHoldTarget(ctx.stack);

  const connected = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port: target.port }, connected.resolve);

  ctx.stack.defer(() => {
    socket.destroy();
  });

  await connected.promise;

  await waitFor(() => {
    expect(target.held.size).toBe(1);
  });

  expect(socket.destroyed).toBeFalse();
});

test('it ends the connections it holds when it stops', async () => {
  const ctx = setupTest();

  const target = await startStubBrokerHoldTarget(ctx.stack);

  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port: target.port }, connected.resolve);

  ctx.stack.defer(() => {
    socket.destroy();
  });

  socket.once('close', () => {
    closed.resolve();
  });

  await connected.promise;

  await waitFor(() => {
    expect(target.held.size).toBe(1);
  });

  await target.stop();

  expect(closed.promise).resolves.toBeUndefined();
});
