import { expect, test } from 'bun:test';
import * as dnsPacket from 'dns-packet';
import { buildMockDnsQuery } from '../test-utils/build-mock-dns-query';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubDnsUpstream } from '../test-utils/start-stub-dns-upstream';
import { createDnsForward } from './dns-upstream';

test('it returns the upstream answer under the id the guest chose', async () => {
  const upstream = await startStubDnsUpstream({
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
  const upstream = await startStubDnsUpstream({ port: findFreePorts(1).take() });

  const forward = createDnsForward(['127.0.0.1'], upstream.port);

  for (let count = 0; count < 8; count += 1) {
    await forward(buildMockDnsQuery({ name: 'example.com', type: 'A', id: 4242 }));
  }

  const ids = upstream.queries.map((query) => query.id);

  // A random id may be 4242 by chance, so no one id is checked. Eight draws
  // are all 4242 with odds of 2^-128, and all one value with odds of 2^-112.
  expect(ids).not.toSatisfyAll((id: number) => id === 4242);
  expect(new Set(ids).size).toBeGreaterThan(1);
});

test('it asks again over TCP when the UDP reply is truncated', async () => {
  const upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
    udp: 'truncate',
  });

  const forward = createDnsForward(['127.0.0.1'], upstream.port);

  const reply = await forward(buildMockDnsQuery({ name: 'example.com', type: 'A', id: 4242 }));

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({
    id: 4242,
    flag_tc: false,
    answers: [{ type: 'A', data: '192.0.2.1' }],
  });

  expect(upstream.queries.map((query) => query.transport)).toStrictEqual(['udp', 'tcp']);
});

test('it fails over to the next upstream when the first refuses with ICMP', async () => {
  const upstream = await startStubDnsUpstream({
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

  const silent = await startStubDnsUpstream({ port, hostname: '127.0.0.2', udp: 'drop' });

  const upstream = await startStubDnsUpstream({
    port,
    answers: [{ type: 'A', name: 'example.com', ttl: 60, data: '192.0.2.1' }],
  });

  const forward = createDnsForward(['127.0.0.2', '127.0.0.1'], port, 250);

  const reply = await forward(buildMockDnsQuery({ name: 'example.com', type: 'A', id: 4242 }));

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({
    id: 4242,
    answers: [{ data: '192.0.2.1' }],
  });

  expect(silent.queries).toHaveLength(1);
  expect(upstream.queries).toHaveLength(1);
});

test('it rejects with every upstream failure when none answers', async () => {
  const upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), udp: 'drop' });

  const forward = createDnsForward(['127.0.0.2', '127.0.0.1'], upstream.port, 50);

  expect(forward(buildMockDnsQuery({ name: 'example.com', type: 'A' }))).rejects.toThrow(
    new Error(
      'no upstream resolver answered (127.0.0.2: ECONNREFUSED: connection refused, recv; 127.0.0.1: timed out)',
    ),
  );
});

test('it gives an upstream 2 s to answer by default', async () => {
  const upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), udp: 'drop' });

  const forward = createDnsForward(['127.0.0.1'], upstream.port);
  const started = performance.now();

  const failure = await forward(buildMockDnsQuery({ name: 'example.com', type: 'A' })).then(
    () => null,
    (error: unknown) => error,
  );

  const elapsedMs = performance.now() - started;

  expect(failure).toStrictEqual(new Error('no upstream resolver answered (127.0.0.1: timed out)'));

  // a timer never fires early; the upper bound is left to the test timeout
  expect(elapsedMs).toBeGreaterThanOrEqual(1990);
});

test('it ignores a UDP reply for another id, and times out', async () => {
  const upstream = await startStubDnsUpstream({ port: findFreePorts(1).take(), udp: 'wrong-id' });

  const forward = createDnsForward(['127.0.0.1'], upstream.port, 50);

  expect(forward(buildMockDnsQuery({ name: 'example.com', type: 'A' }))).rejects.toThrow(
    new Error('no upstream resolver answered (127.0.0.1: timed out)'),
  );
});

test('it refuses a TCP reply for another query', async () => {
  const upstream = await startStubDnsUpstream({
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
  const upstream = await startStubDnsUpstream({
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
  const upstream = await startStubDnsUpstream({
    port: findFreePorts(1).take(),
    udp: 'truncate',
    tcp: 'hang-up',
  });

  const forward = createDnsForward(['127.0.0.1'], upstream.port, 50);

  expect(forward(buildMockDnsQuery({ name: 'example.com', type: 'A' }))).rejects.toThrow(
    new Error('no upstream resolver answered (127.0.0.1: closed before a reply)'),
  );
});
