import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChildTests } from '@imp/test-utils/run-child-tests';
import { waitFor } from '@imp/test-utils/wait-for';
import { buildMockDnsQuery, buildMockDnsReply } from './build-mock-dns-message';
import { findFreePorts } from './find-free-ports';
import { startStubDnsUpstream } from './start-stub-dns-upstream';

test('it answers a UDP query with its records, under the query id', async () => {
  const upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
  });

  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 7 });
  const reply = Promise.withResolvers<Uint8Array>();

  const client = await Bun.udpSocket({
    hostname: '127.0.0.1',
    socket: {
      data: (_socket, data) => {
        reply.resolve(new Uint8Array(data));
      },
    },
  });

  onTestFinished(() => {
    client.close();
  });

  client.send(query, upstream.port, '127.0.0.1');

  const received = await reply.promise;

  expect(received).toStrictEqual(
    buildMockDnsReply(query, {
      answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
    }),
  );

  expect(upstream.queries).toStrictEqual([{ transport: 'udp', id: 7 }]);
});

test('it answers a truncated UDP reply with TC set and no records', async () => {
  const upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
    udp: 'truncate',
  });

  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 7 });
  const reply = Promise.withResolvers<Uint8Array>();

  const client = await Bun.udpSocket({
    hostname: '127.0.0.1',
    socket: {
      data: (_socket, data) => {
        reply.resolve(new Uint8Array(data));
      },
    },
  });

  onTestFinished(() => {
    client.close();
  });

  client.send(query, upstream.port, '127.0.0.1');

  const received = await reply.promise;

  expect(received).toStrictEqual(buildMockDnsReply(query, { truncated: true }));
});

test('it answers a UDP query with the next id when told to', async () => {
  const upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), udp: 'wrong-id' });

  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 7 });
  const reply = Promise.withResolvers<Uint8Array>();

  const client = await Bun.udpSocket({
    hostname: '127.0.0.1',
    socket: {
      data: (_socket, data) => {
        reply.resolve(new Uint8Array(data));
      },
    },
  });

  onTestFinished(() => {
    client.close();
  });

  client.send(query, upstream.port, '127.0.0.1');

  const received = await reply.promise;

  expect(received).toStrictEqual(buildMockDnsReply(query, { id: 8 }));
});

test('it reads a dropped UDP query and sends nothing back', async () => {
  const upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), udp: 'drop' });

  const received: string[] = [];
  const fence = Promise.withResolvers<void>();

  const client = await Bun.udpSocket({
    hostname: '127.0.0.1',
    socket: {
      data: (_socket, data) => {
        const text = Buffer.from(data).toString();

        received.push(text);

        if (text === 'fence') {
          fence.resolve();
        }
      },
    },
  });

  onTestFinished(() => {
    client.close();
  });

  client.send(
    buildMockDnsQuery({ name: 'example.com', type: 'A', id: 7 }),
    upstream.port,
    '127.0.0.1',
  );

  await waitFor(() => {
    expect(upstream.queries).toHaveLength(1);
  });

  // a datagram to itself: the socket reads it after any reply already sent
  client.send('fence', client.port, '127.0.0.1');

  await fence.promise;

  expect(received).toStrictEqual(['fence']);
  expect(upstream.queries).toStrictEqual([{ transport: 'udp', id: 7 }]);
});

test('it answers a TCP query that comes in two writes, with the length in front', async () => {
  const upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
  });

  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 7 });
  const length = Buffer.alloc(2);
  const reply = Promise.withResolvers<Buffer>();

  length.writeUInt16BE(query.byteLength, 0);

  const socket = connect({ host: '127.0.0.1', port: upstream.port }, () => {
    socket.write(length);
    socket.write(query);
  });

  onTestFinished(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    reply.resolve(chunk);
  });

  const expected = buildMockDnsReply(query, {
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
  });

  const framed = Buffer.alloc(2 + expected.byteLength);

  framed.writeUInt16BE(expected.byteLength, 0);
  framed.set(expected, 2);

  const received = await reply.promise;

  expect(received).toStrictEqual(framed);
  expect(upstream.queries).toStrictEqual([{ transport: 'tcp', id: 7 }]);
});

test('it closes a TCP connection at once without a reply when told to hang up', async () => {
  const upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), tcp: 'hang-up' });

  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 7, edns: false });
  const framed = Buffer.alloc(2 + query.byteLength);
  const closed = Promise.withResolvers<void>();
  const received: Buffer[] = [];

  framed.writeUInt16BE(query.byteLength, 0);
  framed.set(query, 2);

  const socket = connect({ host: '127.0.0.1', port: upstream.port }, () => {
    socket.write(framed);
  });

  onTestFinished(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    received.push(chunk);
  });

  socket.on('close', () => {
    closed.resolve();
  });

  await closed.promise;

  expect(received).toStrictEqual([]);
  expect(upstream.queries).toStrictEqual([{ transport: 'tcp', id: 7 }]);
});

test('it holds a dropped TCP query open without a reply', async () => {
  const upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), tcp: 'drop' });

  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 7, edns: false });
  const framed = Buffer.alloc(2 + query.byteLength);
  const received: Buffer[] = [];

  framed.writeUInt16BE(query.byteLength, 0);
  framed.set(query, 2);

  const socket = connect({ host: '127.0.0.1', port: upstream.port }, () => {
    socket.write(framed);
  });

  onTestFinished(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    received.push(chunk);
  });

  await waitFor(() => {
    expect(upstream.queries).toHaveLength(1);
  });

  expect(received).toStrictEqual([]);
  expect(socket.destroyed).toBeFalse();
});

test('it answers a TCP query with the next id when told to', async () => {
  const upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), tcp: 'wrong-id' });

  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 7, edns: false });
  const framed = Buffer.alloc(2 + query.byteLength);
  const reply = Promise.withResolvers<Buffer>();

  framed.writeUInt16BE(query.byteLength, 0);
  framed.set(query, 2);

  const socket = connect({ host: '127.0.0.1', port: upstream.port }, () => {
    socket.write(framed);
  });

  onTestFinished(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    reply.resolve(chunk);
  });

  const received = await reply.promise;

  expect(received.subarray(2)).toStrictEqual(Buffer.from(buildMockDnsReply(query, { id: 8 })));
});

test('it listens on the loopback address it is given', async () => {
  const upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    hostname: '127.0.0.2',
  });

  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 7 });
  const reply = Promise.withResolvers<string>();

  const client = await Bun.udpSocket({
    hostname: '127.0.0.1',
    socket: {
      data: (_socket, _data, _port, address) => {
        reply.resolve(address);
      },
    },
  });

  onTestFinished(() => {
    client.close();
  });

  client.send(query, upstream.port, '127.0.0.2');

  const from = await reply.promise;

  expect(from).toBe('127.0.0.2');
});

test('it frees its port when the test that started it finishes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stub-dns-upstream-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const port = findFreePorts(1).take();

  const run = runChildTests(
    dir,
    [
      "import { expect, test } from 'bun:test';",
      `import { startStubDnsUpstream } from ${JSON.stringify(join(import.meta.dir, 'start-stub-dns-upstream.ts'))};`,
      `test('it starts', async () => { await startStubDnsUpstream({ port: ${String(port)} }); });`,
      "test('it finds the port free', async () => {",
      `  const udp = await Bun.udpSocket({ hostname: '127.0.0.1', port: ${String(port)} });`,
      `  const tcp = Bun.listen({ hostname: '127.0.0.1', port: ${String(port)}, socket: { data: () => {} } });`,
      '  const ports = [udp.port, tcp.port];',
      '  udp.close();',
      '  tcp.stop(true);',
      `  expect(ports).toStrictEqual([${String(port)}, ${String(port)}]);`,
      '});',
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});
