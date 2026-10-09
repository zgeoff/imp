import { expect, mock, onTestFinished, test } from 'bun:test';
import { createConnection } from 'node:net';
import type { EgressMode } from '@imp/api';
import type { BrokerPeer } from '../db/secrets';
import { parseSubnet } from '../net/addressing';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubBrokerGuestSocket } from '../test-utils/start-stub-broker-guest-socket';
import { startStubBrokerReplyTarget } from '../test-utils/start-stub-broker-reply-target';
import { startBrokerFront } from './broker-front';
import { TunnelRefusedError, resolveTunnelTarget } from './tunnel-target';

// The front on 127.0.0.0/16: slot 0's gateway is 127.0.0.1 and its guest
// 127.0.0.2, so a socket bound to 127.0.0.2 is that guest.

function setupTest() {
  // the front and the guests that dial it: a guest is deferred after the
  // front, so it closes first
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it turns away an imp past its connection cap with 503', async () => {
  const ctx = setupTest();

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.reject(new Error('no tunnel in this test')),
    log: () => {},
    maxConnectionsPerImp: 1,
  });

  ctx.stack.defer(() => front.stop());

  await startStubBrokerGuestSocket(ctx.stack, { port: front.port, address: '127.0.0.2' });

  const second = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  expect(second.reply).resolves.toBe(
    'HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain\r\ncontent-length: 42\r\nconnection: close\r\n\r\ntoo many broker connections from this imp\n',
  );
});

test('it cuts off a client whose time to finish its head runs out mid-head', async () => {
  const ctx = setupTest();

  const deadline = new AbortController();

  const reading = Promise.withResolvers<void>();

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.reject(new Error('no tunnel in this test')),
    log: () => {},

    // the imp is found and the head is being read once the deadline starts
    startHeadDeadline: () => {
      reading.resolve();

      return deadline.signal;
    },
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  await reading.promise;

  guest.write('CONNECT github.com:443 HTTP/1.1\r\n');
  deadline.abort();

  expect(guest.reply).resolves.toBe('');
});

test('it cuts off a client whose time is up before its head is read', async () => {
  const ctx = setupTest();

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.reject(new Error('no tunnel in this test')),
    log: () => {},
    startHeadDeadline: () => AbortSignal.abort(),
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write('CONNECT github.com:443 HTTP/1.1\r\n\r\n');

  expect(guest.reply).resolves.toBe('');
});

test('it gives a client 10 seconds to send its head', async () => {
  const ctx = setupTest();
  const startHeadDeadline = mock<(ms: number) => AbortSignal>(() => new AbortController().signal);

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.reject(new Error('no tunnel in this test')),
    log: () => {},
    startHeadDeadline,
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write('GET / HTTP/1.1\r\n\r\n');

  await guest.reply;

  expect(startHeadDeadline).toHaveBeenCalledExactlyOnceWith(10_000);
});

test('it cuts off a head past the size limit', async () => {
  const ctx = setupTest();

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.reject(new Error('no tunnel in this test')),
    log: () => {},
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write(`CONNECT github.com:443 HTTP/1.1\r\nx-pad: ${'a'.repeat(9000)}`);

  expect(guest.reply).resolves.toBe('');
});

test('it closes a connection from a slot with no imp', async () => {
  const ctx = setupTest();

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () => Promise.resolve(undefined),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.reject(new Error('no tunnel in this test')),
    log: () => {},
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write('CONNECT github.com:443 HTTP/1.1\r\n\r\n');

  expect(guest.reply).resolves.toBe('');
});

test('it closes a connection whose slot changed imps while its head came', async () => {
  const ctx = setupTest();
  const findPeer = mock<(slot: number) => Promise<BrokerPeer | undefined>>();

  findPeer
    .mockResolvedValueOnce({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } })
    .mockResolvedValueOnce({ id: 'imp-2', name: 'other', egress: { mode: 'open', allow: [] } });

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer,
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.resolve('127.0.0.1'),
    log: () => {},
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write('CONNECT host.test:443 HTTP/1.1\r\n\r\n');

  expect(guest.reply).resolves.toBe('');
});

test('it refuses a tunnel to a target the check refuses with a 403 that says why', async () => {
  const ctx = setupTest();

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: (host) =>
      resolveTunnelTarget(host, {
        resolve: () => Promise.resolve(['10.0.0.1']),
        readHostAddresses: () => new Set(),
      }),
    log: () => {},
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write('CONNECT inside.test:443 HTTP/1.1\r\n\r\n');

  expect(guest.reply).resolves.toBe(
    'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 63\r\nconnection: close\r\n\r\ninside.test resolves to 10.0.0.1, which a tunnel may not reach\n',
  );
});

test("it resolves a public imp's tunnel under the public policy", async () => {
  const ctx = setupTest();
  const resolve = mock<(host: string, mode: EgressMode) => Promise<string>>();

  resolve.mockRejectedValue(new TunnelRefusedError('host.test resolves to 8.8.4.4'));

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'public', allow: [] } }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: resolve,
    log: () => {},
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write('CONNECT host.test:443 HTTP/1.1\r\n\r\n');

  await guest.reply;

  expect(resolve).toHaveBeenCalledExactlyOnceWith('host.test', 'public');
});

test('it answers 502 when resolving the target fails for another reason', async () => {
  const ctx = setupTest();

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: (host) =>
      resolveTunnelTarget(host, {
        resolve: () => Promise.reject(new Error('getaddrinfo ENOTFOUND host.test')),
        readHostAddresses: () => new Set(),
      }),
    log: () => {},
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write('CONNECT host.test:443 HTTP/1.1\r\n\r\n');

  expect(guest.reply).resolves.toBe(
    'HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\ncontent-length: 32\r\nconnection: close\r\n\r\ngetaddrinfo ENOTFOUND host.test\n',
  );
});

test('it answers 502 when the tunnel target refuses the connection', async () => {
  const ctx = setupTest();
  const deadPort = findFreePorts(1).take();

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted: () => Promise.resolve(false),
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.resolve('127.0.0.1'),
    dialTunnel: (address) => createConnection({ host: address, port: deadPort }),
    log: () => {},
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write('CONNECT host.test:443 HTTP/1.1\r\n\r\n');

  expect(guest.reply).resolves.toBe(
    'HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\ncontent-length: 18\r\nconnection: close\r\n\r\ncould not connect\n',
  );
});

test('it tunnels a granted host on a port other than 443 without a grant lookup', async () => {
  const ctx = setupTest();

  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  const isGranted = mock(() => Promise.resolve(true));

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted,
    openTerminator: () => Promise.reject(new Error('no terminator in this test')),
    resolveTunnelTarget: () => Promise.resolve('127.0.0.1'),
    dialTunnel: (address) => createConnection({ host: address, port: target.port }),
    log: () => {},
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write(
    'CONNECT api.github.com:22 HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\nHost: api.github.com\r\n\r\n',
  );

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\ntunnel',
  );

  expect(target.received).toStrictEqual(['GET / HTTP/1.1\r\nHost: api.github.com\r\n\r\n']);
  expect(isGranted).not.toHaveBeenCalled();
});

test('it logs a failure of the connection and closes it', async () => {
  const ctx = setupTest();
  const logs: string[] = [];

  const front = await startBrokerFront(0, {
    subnet: parseSubnet('127.0.0.0/16'),
    findPeer: () =>
      Promise.resolve({ id: 'imp-1', name: 'dev', egress: { mode: 'open', allow: [] } }),
    isGranted: () => Promise.resolve(true),
    openTerminator: () => Promise.reject(new Error('the terminator would not start')),
    resolveTunnelTarget: () => Promise.reject(new Error('no tunnel in this test')),
    log: (message) => {
      logs.push(message);
    },
  });

  ctx.stack.defer(() => front.stop());

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: front.port,
    address: '127.0.0.2',
  });

  guest.write('CONNECT api.github.com:443 HTTP/1.1\r\n\r\n');

  const reply = await guest.reply;

  expect(reply).toBe('');
  expect(logs).toStrictEqual(['impd: broker: the terminator would not start']);
});
