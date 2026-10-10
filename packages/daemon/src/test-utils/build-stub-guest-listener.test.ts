import { expect, test } from 'bun:test';
import { buildStubGuestListener } from './build-stub-guest-listener';

test('it listens on the unix path asked for', () => {
  const stub = buildStubGuestListener('fwd1', { network: 'unix', path: '/tmp/app.sock' });

  expect(stub.listener).toStrictEqual({
    id: 'fwd1',
    path: '/tmp/app.sock',
    port: null,
    connections: expect.toBeFunction(),
    close: expect.toBeFunction(),
  });
});

test('it picks a socket path under the forward directory when none is asked for', () => {
  const stub = buildStubGuestListener('fwd1', { network: 'unix', path: null });

  expect(stub.listener.path).toBe('/run/imp/forward/fwd1/sock');
});

test('it listens on the port asked for', () => {
  const stub = buildStubGuestListener('fwd1', { network: 'tcp', port: 8080 });

  expect(stub.listener).toStrictEqual({
    id: 'fwd1',
    path: null,
    port: 8080,
    connections: expect.toBeFunction(),
    close: expect.toBeFunction(),
  });
});

test('it picks a port for port 0', () => {
  const stub = buildStubGuestListener('fwd1', { network: 'tcp', port: 0 });

  expect(stub.listener.port).toBe(41_000);
});

test('it names each client in order until the listener ends', async () => {
  const stub = buildStubGuestListener('fwd1', { network: 'unix', path: null });

  stub.connect(1);
  stub.connect(2);
  stub.end();

  const connections = await Array.fromAsync(stub.listener.connections());

  expect(connections).toStrictEqual([1, 2]);
});

test('it ends the clients once impd closes the listener', async () => {
  const stub = buildStubGuestListener('fwd1', { network: 'unix', path: null });

  stub.listener.close();

  const connections = await Array.fromAsync(stub.listener.connections());

  expect(connections).toStrictEqual([]);
  expect(stub.state.isClosed).toBeTrue();
});
