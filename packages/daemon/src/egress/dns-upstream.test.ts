import { expect, test } from 'bun:test';
import * as dnsPacket from 'dns-packet';
import { buildMockDnsQuery } from '../test-utils/build-mock-dns-message';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubDnsUpstream } from '../test-utils/start-stub-dns-upstream';
import { createDnsForward } from './dns-upstream';

test('it returns the upstream answer under the id the guest chose', async () => {
  using upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
  });

  const forward = createDnsForward(['127.0.0.1'], upstream.port);

  const reply = await forward(buildMockDnsQuery({ name: 'example.com', type: 'A', id: 4242 }));

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({
    id: 4242,
    type: 'response',
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
  });
});

test('it asks each upstream under a fresh random id, not the guest one', async () => {
  using upstream = await startStubDnsUpstream({ port: findFreePorts(1).take() });

  const forward = createDnsForward(['127.0.0.1'], upstream.port);

  for (let count = 0; count < 8; count += 1) {
    await forward(buildMockDnsQuery({ name: 'example.com', type: 'A', id: 4242 }));
  }

  // eight draws of a 16-bit id are all one value with odds of 2^-112
  expect(new Set(upstream.queries.map((query) => query.id)).size).toBeGreaterThan(1);
});

test('it asks again over TCP when the UDP reply is truncated', async () => {
  using upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
    udp: 'truncate',
  });

  const forward = createDnsForward(['127.0.0.1'], upstream.port);

  const reply = await forward(buildMockDnsQuery({ name: 'example.com', type: 'A', id: 4242 }));

  expect({
    reply: dnsPacket.decode(Buffer.from(reply)),
    transports: upstream.queries.map((query) => query.transport),
  }).toMatchObject({
    reply: { id: 4242, flag_tc: false, answers: [{ type: 'A', data: '192.0.2.1' }] },
    transports: ['udp', 'tcp'],
  });
});

test('it fails over to the next upstream when the first refuses with ICMP', async () => {
  using upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
  });

  // nothing listens on 127.0.0.2 at the port
  const forward = createDnsForward(['127.0.0.2', '127.0.0.1'], upstream.port);

  const reply = await forward(buildMockDnsQuery({ name: 'example.com', type: 'A', id: 4242 }));

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({
    id: 4242,
    answers: [{ type: 'A', data: '192.0.2.1' }],
  });
});

test('it fails over to the next upstream when the first does not answer in time', async () => {
  const port = findFreePorts(1).take();

  using silent = await startStubDnsUpstream({ port, hostname: '127.0.0.2', udp: 'drop' });

  using upstream = await startStubDnsUpstream({
    port,
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
  });

  const forward = createDnsForward(['127.0.0.2', '127.0.0.1'], port, 250);

  const reply = await forward(buildMockDnsQuery({ name: 'example.com', type: 'A', id: 4242 }));

  expect({
    reply: dnsPacket.decode(Buffer.from(reply)),
    asked: [silent.queries.length, upstream.queries.length],
  }).toMatchObject({ reply: { id: 4242, answers: [{ data: '192.0.2.1' }] }, asked: [1, 1] });
});

test('it rejects with every upstream failure when none answers', async () => {
  using upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), udp: 'drop' });

  const forward = createDnsForward(['127.0.0.2', '127.0.0.1'], upstream.port, 50);

  expect(forward(buildMockDnsQuery({ name: 'example.com', type: 'A' }))).rejects.toThrow(
    new Error(
      'no upstream resolver answered (127.0.0.2: ECONNREFUSED: connection refused, recv; 127.0.0.1: timed out)',
    ),
  );
});

test('it ignores a UDP reply for another id, and times out', async () => {
  using upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), udp: 'wrong-id' });

  const forward = createDnsForward(['127.0.0.1'], upstream.port, 50);

  expect(forward(buildMockDnsQuery({ name: 'example.com', type: 'A' }))).rejects.toThrow(
    new Error('no upstream resolver answered (127.0.0.1: timed out)'),
  );
});

test('it refuses a TCP reply for another query', async () => {
  using upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    udp: 'truncate',
    tcp: 'wrong-id',
  });

  const forward = createDnsForward(['127.0.0.1'], upstream.port, 50);

  expect(forward(buildMockDnsQuery({ name: 'example.com', type: 'A' }))).rejects.toThrow(
    new Error('no upstream resolver answered (127.0.0.1: the reply is for another query)'),
  );
});

test('it times out a TCP upstream that does not answer', async () => {
  using upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    udp: 'truncate',
    tcp: 'drop',
  });

  const forward = createDnsForward(['127.0.0.1'], upstream.port, 50);

  expect(forward(buildMockDnsQuery({ name: 'example.com', type: 'A' }))).rejects.toThrow(
    new Error('no upstream resolver answered (127.0.0.1: timed out)'),
  );
});

test('it fails a TCP upstream that closes before a reply', async () => {
  using upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    udp: 'truncate',
    tcp: 'hang-up',
  });

  const forward = createDnsForward(['127.0.0.1'], upstream.port, 50);

  expect(forward(buildMockDnsQuery({ name: 'example.com', type: 'A' }))).rejects.toThrow(
    new Error('no upstream resolver answered (127.0.0.1: closed before a reply)'),
  );
});
