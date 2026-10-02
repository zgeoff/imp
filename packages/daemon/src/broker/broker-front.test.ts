import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { parseSubnet } from '../net/addressing';
import { startBrokerFront } from './broker-front';
import type { BrokerFrontDeps } from './broker-front';
import { TunnelRefusedError } from './tunnel-target';

// slot 0 of 127.0.0.0/16: the gateway is 127.0.0.1, the guest 127.0.0.2
async function setupFront(overrides: Partial<BrokerFrontDeps> = {}) {
  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () => Promise.resolve({ id: 'imp-1', name: 'dev', egressPolicy: 'open' }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.reject(new Error('no tunnel in this test')),
    log: () => {},
    ...overrides,
  });

  const address = front.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return { front, port, [Symbol.asyncDispose]: () => front.stop() };
}

function openGuestSocket(port: number): Promise<Socket> {
  const ready = Promise.withResolvers<Socket>();

  const socket = connect({ host: '127.0.0.1', port, localAddress: '127.0.0.2' }, () => {
    ready.resolve(socket);
  });

  socket.once('error', ready.reject);

  return ready.promise;
}

// everything the broker sends until it closes the connection
async function readUntilClose(socket: Socket): Promise<string> {
  const chunks: Uint8Array[] = [];
  const closed = Promise.withResolvers<void>();

  socket.on('data', (chunk: Uint8Array) => {
    chunks.push(chunk);
  });

  socket.once('close', () => {
    closed.resolve();
  });

  await closed.promise;

  return Buffer.concat(chunks).toString();
}

test('an imp past its connection cap is turned away', async () => {
  await using ctx = await setupFront({ maxConnectionsPerImp: 1 });

  const first = await openGuestSocket(ctx.port);
  const second = await openGuestSocket(ctx.port);
  const reply = await readUntilClose(second);

  expect(reply).toStartWith('HTTP/1.1 503');

  first.destroy();
});

test('a client that never finishes its head is cut off', async () => {
  await using ctx = await setupFront({ headTimeoutMs: 50 });

  const socket = await openGuestSocket(ctx.port);

  socket.write('CONNECT github.com:443 HTTP/1.1\r\n');

  const reply = await readUntilClose(socket);

  expect(reply).toBe('');
});

test('a head past the size limit is cut off', async () => {
  await using ctx = await setupFront();

  const socket = await openGuestSocket(ctx.port);

  socket.write(`CONNECT github.com:443 HTTP/1.1\r\nx-pad: ${'a'.repeat(9000)}`);

  const reply = await readUntilClose(socket);

  expect(reply).toBe('');
});

test('a refused tunnel target is a 403 that says why', async () => {
  await using ctx = await setupFront({
    resolveTunnelTarget: () =>
      Promise.reject(new TunnelRefusedError('inside.test resolves to 10.0.0.1')),
  });

  const socket = await openGuestSocket(ctx.port);

  socket.write('CONNECT inside.test:443 HTTP/1.1\r\n\r\n');

  const reply = await readUntilClose(socket);

  expect(reply).toStartWith('HTTP/1.1 403');
  expect(reply).toContain('resolves to 10.0.0.1');
});
