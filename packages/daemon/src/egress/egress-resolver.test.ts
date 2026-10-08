import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { waitFor } from '@imp/test-utils/wait-for';
import * as dnsPacket from 'dns-packet';
import { parseSubnet } from '../net/addressing';
import { buildMockDnsQuery, buildMockDnsReply } from '../test-utils/build-mock-dns-message';
import { buildMockNetworkMember } from '../test-utils/build-mock-network-member';
import { buildStubEgressService } from '../test-utils/build-stub-egress-service';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubDnsUpstream } from '../test-utils/start-stub-dns-upstream';
import { createDnsForward } from './dns-upstream';
import {
  createQueryHandler,
  createSocketErrorReport,
  startResolverServer,
} from './egress-resolver';

// In 10.66.0.0/16, slot 0's guest is 10.66.0.2 and slot 1's 10.66.0.6.

test('#createQueryHandler admits the CNAME chain and its A records, and nothing off the chain', async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: { 'registry.npmjs.org': 'admit' } },
    upstream: {
      'registry.npmjs.org': [
        { type: 'CNAME', name: 'registry.npmjs.org', ttl: 300, data: 'npm.cdn.test' },
        { type: 'A', name: 'npm.cdn.test', ttl: 200_000, data: '104.16.0.1' },
        { type: 'A', name: 'npm.cdn.test', ttl: 60, data: '104.16.0.2' },
        { type: 'A', name: 'smuggled.test', ttl: 60, data: '6.6.6.6' },
      ],
    },
  });

  const handle = createQueryHandler(egress.deps);

  await handle('10.66.0.6', buildMockDnsQuery({ name: 'Registry.NPMJS.org.', type: 'A' }));

  expect(egress.admitted).toStrictEqual([
    {
      slot: 1,
      names: ['registry.npmjs.org', 'npm.cdn.test'],
      answers: [
        { address: '104.16.0.1', ttlS: 200_000 },
        { address: '104.16.0.2', ttlS: 60 },
      ],
    },
  ]);
});

test('#createQueryHandler caps each TTL of a reply at maxTtlS', async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: { 'registry.npmjs.org': 'admit' } },
    upstream: {
      'registry.npmjs.org': [
        { type: 'CNAME', name: 'registry.npmjs.org', ttl: 600, data: 'npm.cdn.test' },
        { type: 'A', name: 'npm.cdn.test', ttl: 60, data: '104.16.0.1' },
      ],
    },
  });

  const handle = createQueryHandler({ ...egress.deps, maxTtlS: 300 });

  const reply = await handle(
    '10.66.0.6',
    buildMockDnsQuery({ name: 'registry.npmjs.org', type: 'A' }),
  );

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({
    answers: [{ ttl: 300 }, { ttl: 60 }],
  });
});

test('#createQueryHandler stops at a CNAME loop, and admits only the records on the chain', async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: { 'a.test': 'admit' } },
    upstream: {
      'a.test': [
        { type: 'CNAME', name: 'a.test', ttl: 300, data: 'b.test' },
        { type: 'CNAME', name: 'b.test', ttl: 300, data: 'a.test' },
        { type: 'A', name: 'b.test', ttl: 300, data: '192.0.2.1' },
      ],
    },
  });

  const handle = createQueryHandler(egress.deps);

  await handle('10.66.0.6', buildMockDnsQuery({ name: 'a.test', type: 'A' }));

  expect(egress.admitted).toStrictEqual([
    { slot: 1, names: ['a.test', 'b.test'], answers: [{ address: '192.0.2.1', ttlS: 300 }] },
  ]);
});

test('#createQueryHandler forwards an admitted query of another type without a set write', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'admit' } } });
  const handle = createQueryHandler(egress.deps);
  const query = buildMockDnsQuery({ name: 'github.com', type: 'MX' });

  const reply = await handle('10.66.0.6', query);

  expect(reply).toStrictEqual(buildMockDnsReply(query));
  expect(egress.forwarded).toStrictEqual(['github.com']);
  expect(egress.admitted).toStrictEqual([]);
});

test('#createQueryHandler drops the addresses a public imp may not reach from every section of a screened reply', async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: { 'rebind.test': 'screen' } },
    screened: ['10.250.77.1', '::ffff:a00:1', '10.0.0.53', '10.0.0.54'],
  });

  const handle = createQueryHandler({
    ...egress.deps,
    forward: (query) =>
      Promise.resolve(
        buildMockDnsReply(query, {
          answers: [
            { type: 'CNAME', name: 'rebind.test', ttl: 300, data: 'inside.test' },
            { type: 'A', name: 'inside.test', ttl: 60, data: '10.250.77.1' },
            { type: 'A', name: 'inside.test', ttl: 60, data: '93.184.215.14' },
            { type: 'AAAA', name: 'inside.test', ttl: 60, data: '::ffff:a00:1' },
            { type: 'AAAA', name: 'inside.test', ttl: 60, data: '2606:2800:21f:cb07::1' },
          ],
          authorities: [
            { type: 'A', name: 'ns.inside.test', ttl: 60, data: '10.0.0.53' },
            { type: 'A', name: 'ns2.inside.test', ttl: 60, data: '93.184.215.53' },
          ],
          additionals: [{ type: 'A', name: 'ns.inside.test', ttl: 60, data: '10.0.0.54' }],
        }),
      ),
  });

  const reply = await handle('10.66.0.6', buildMockDnsQuery({ name: 'rebind.test', type: 'A' }));

  // the chain stays, TTLs as they came: no set holds a public imp's answers
  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({
    answers: [
      { type: 'CNAME', data: 'inside.test', ttl: 300 },
      { type: 'A', data: '93.184.215.14', ttl: 60 },
      { type: 'AAAA', data: '2606:2800:21f:cb07::1', ttl: 60 },
    ],
    authorities: [{ type: 'A', data: '93.184.215.53' }],
    additionals: [],
  });

  expect(egress.admitted).toStrictEqual([]);
});

test('#createQueryHandler replies only once the addresses are in nft', async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: { 'github.com': 'admit' } },
    upstream: { 'github.com': [{ type: 'A', name: 'github.com', ttl: 60, data: '140.82.112.3' }] },
  });

  const reached = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  const state = { replied: false };

  const handle = createQueryHandler({
    ...egress.deps,
    writeAnswers: () => {
      reached.resolve();

      return written.promise;
    },
  });

  const reply = (async () => {
    await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

    state.replied = true;
  })();

  await reached.promise;

  const beforeWritten = state.replied;

  written.resolve();

  await reply;

  expect(beforeWritten).toBeFalse();
  expect(state.replied).toBeTrue();
});

test('#createQueryHandler refuses a denied name with EDE 18, and never sends it upstream', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: {} } });
  const handle = createQueryHandler(egress.deps);

  const reply = await handle('10.66.0.6', buildMockDnsQuery({ name: 'example.org', type: 'A' }));

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({
    rcode: 'REFUSED',
    questions: [{ name: 'example.org', type: 'A', class: 'IN' }],
  });

  // option 15, two bytes long, info code 18
  expect(Buffer.from(reply.subarray(-6)).toString('hex')).toBe('000f00020012');
  expect(egress.forwarded).toStrictEqual([]);
});

test('#createQueryHandler refuses a denied name with no OPT record when the query had none', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: {} } });
  const handle = createQueryHandler(egress.deps);

  const reply = await handle(
    '10.66.0.6',
    buildMockDnsQuery({ name: 'example.org', type: 'A', edns: false }),
  );

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({
    rcode: 'REFUSED',
    additionals: [],
  });
});

// slot 1's /30 holds 10.66.0.5 and 10.66.0.7 too; slot 0 holds no imp
test.each(['10.66.0.7', '10.66.0.5', '10.66.0.2', '192.0.2.1'])(
  '#createQueryHandler refuses a query from %p, which is no guest with an imp',
  async (source) => {
    const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'admit' } } });
    const handle = createQueryHandler(egress.deps);

    const reply = await handle(source, buildMockDnsQuery({ name: 'github.com', type: 'A' }));

    expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({ rcode: 'REFUSED' });
    expect(egress.forwarded).toStrictEqual([]);
  },
);

test('#createQueryHandler refuses a query with two questions, and never sends it upstream', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'admit' } } });
  const handle = createQueryHandler(egress.deps);
  const single = buildMockDnsQuery({ name: 'github.com', type: 'A', edns: false });
  const twice = Uint8Array.from([...single, ...single.subarray(12)]);

  twice[5] = 2;

  const reply = await handle('10.66.0.6', twice);

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({ rcode: 'REFUSED' });
  expect(egress.forwarded).toStrictEqual([]);
});

test('#createQueryHandler answers AAAA with no data and never sends it upstream when imps have no IPv6', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'admit' } } });
  const handle = createQueryHandler(egress.deps);

  const reply = await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'AAAA' }));

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({ rcode: 'NOERROR', answers: [] });
  expect(egress.forwarded).toStrictEqual([]);
  expect(egress.admitted).toStrictEqual([]);
});

test('#createQueryHandler admits an allowed AAAA answer as it does an A one when imps have IPv6', async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: { 'registry.npmjs.org': 'admit' } },
    upstream: {
      'registry.npmjs.org': [
        { type: 'CNAME', name: 'registry.npmjs.org', ttl: 300, data: 'npm.cdn.test' },
        { type: 'AAAA', name: 'npm.cdn.test', ttl: 60, data: '2606:4700::6810:1' },
        { type: 'A', name: 'npm.cdn.test', ttl: 60, data: '104.16.0.1' },
      ],
    },
  });

  const handle = createQueryHandler({ ...egress.deps, ipv6: true });

  await handle('10.66.0.6', buildMockDnsQuery({ name: 'registry.npmjs.org', type: 'AAAA' }));

  expect(egress.admitted).toStrictEqual([
    {
      slot: 1,
      names: ['registry.npmjs.org', 'npm.cdn.test'],
      answers: [{ address: '2606:4700::6810:1', ttlS: 60 }],
    },
  ]);
});

test('#createQueryHandler forwards the name of a host the broker serves, and adds nothing', async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: { 'api.github.com': 'answer' } },
    upstream: {
      'api.github.com': [{ type: 'A', name: 'api.github.com', ttl: 60, data: '140.82.112.6' }],
    },
  });

  const handle = createQueryHandler(egress.deps);

  await handle('10.66.0.6', buildMockDnsQuery({ name: 'api.github.com', type: 'A' }));

  expect(egress.forwarded).toStrictEqual(['api.github.com']);
  expect(egress.admitted).toStrictEqual([]);
});

test('#createQueryHandler refuses a slot past its burst', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'answer' } } });

  const handle = createQueryHandler({
    ...egress.deps,
    readRate: () => ({ burst: 2, perSecond: 1 }),
  });

  await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));
  await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  const limited = await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  expect(dnsPacket.decode(Buffer.from(limited))).toMatchObject({ rcode: 'REFUSED' });
});

test('#createQueryHandler answers a slot past its burst again once its bucket refills', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'answer' } } });

  const handle = createQueryHandler({
    ...egress.deps,
    readRate: () => ({ burst: 2, perSecond: 1 }),
  });

  await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));
  await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  const limited = await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  egress.advance(1000);

  const refilled = await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  expect(dnsPacket.decode(Buffer.from(limited))).toMatchObject({ rcode: 'REFUSED' });
  expect(dnsPacket.decode(Buffer.from(refilled))).toMatchObject({ rcode: 'NOERROR' });
});

test('#createQueryHandler refuses a rate-limited query plainly, with no EDE 18', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'answer' } } });

  const handle = createQueryHandler({
    ...egress.deps,
    readRate: () => ({ burst: 1, perSecond: 1 }),
  });

  await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  const limited = await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  expect(dnsPacket.decode(Buffer.from(limited))).toMatchObject({
    rcode: 'REFUSED',
    additionals: [],
  });
});

test("#createQueryHandler keeps each slot's rate its own", async () => {
  const egress = buildStubEgressService({
    verdicts: { 0: { 'github.com': 'answer' }, 1: { 'github.com': 'answer' } },
  });

  const handle = createQueryHandler({
    ...egress.deps,
    readRate: () => ({ burst: 1, perSecond: 0 }),
  });

  await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  const other = await handle('10.66.0.2', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  expect(dnsPacket.decode(Buffer.from(other))).toMatchObject({ rcode: 'NOERROR' });
});

test("#createQueryHandler answers a peer's name itself, with authority, whatever the policy refuses", async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: {} },
    networks: ['lab'],
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'box', slot: 1, guestIp: '10.66.0.6' }),
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
    ],
  });

  const handle = createQueryHandler(egress.deps);

  const reply = await handle(
    '10.66.0.6',
    buildMockDnsQuery({ name: 'Web.Lab.Internal.', type: 'A' }),
  );

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({
    rcode: 'NOERROR',
    flag_aa: true,
    answers: [{ type: 'A', name: 'web.lab.internal', data: '10.66.0.2' }],
  });

  expect(egress.forwarded).toStrictEqual([]);
});

test("#createQueryHandler answers AAAA for a peer's name with no data, and never sends it upstream, with IPv6", async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: {} },
    networks: ['lab'],
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'box', slot: 1, guestIp: '10.66.0.6' }),
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
    ],
  });

  const handle = createQueryHandler({ ...egress.deps, ipv6: true });

  const reply = await handle(
    '10.66.0.6',
    buildMockDnsQuery({ name: 'web.lab.internal', type: 'AAAA' }),
  );

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({ rcode: 'NOERROR', answers: [] });
  expect(egress.forwarded).toStrictEqual([]);
});

// slot 2 (10.66.0.10) is on no network; nobody is no peer on lab
test.each([
  ['10.66.0.10', 'web.lab.internal'],
  ['10.66.0.6', 'nobody.lab.internal'],
])(
  '#createQueryHandler answers %p NXDOMAIN for %p, a network name it may not see, and never sends it upstream',
  async (source, name) => {
    const egress = buildStubEgressService({
      verdicts: { 1: {}, 2: {} },
      networks: ['lab'],
      members: [
        buildMockNetworkMember({ network: 'lab', name: 'box', slot: 1, guestIp: '10.66.0.6' }),
        buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      ],
    });

    const handle = createQueryHandler(egress.deps);

    const reply = await handle(source, buildMockDnsQuery({ name, type: 'A' }));

    expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({ rcode: 'NXDOMAIN' });
    expect(egress.forwarded).toStrictEqual([]);
  },
);

test('#createQueryHandler answers SERVFAIL and logs why when no upstream answers', async () => {
  const egress = buildStubEgressService({ verdicts: { 1: { 'github.com': 'admit' } } });

  const handle = createQueryHandler({
    ...egress.deps,
    forward: () => Promise.reject(new Error('no upstream resolver answered')),
  });

  const reply = await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({ rcode: 'SERVFAIL' });

  expect(egress.logs).toStrictEqual([
    'impd: egress: github.com for slot 1: no upstream resolver answered',
  ]);
});

test('#createQueryHandler answers SERVFAIL and logs why when the set cannot take the answer', async () => {
  const egress = buildStubEgressService({
    verdicts: { 1: { 'github.com': 'admit' } },
    upstream: { 'github.com': [{ type: 'A', name: 'github.com', ttl: 60, data: '140.82.112.3' }] },
  });

  const handle = createQueryHandler({
    ...egress.deps,
    writeAnswers: () => Promise.reject(new Error('nft exited 1: set is full')),
  });

  const reply = await handle('10.66.0.6', buildMockDnsQuery({ name: 'github.com', type: 'A' }));

  expect(dnsPacket.decode(Buffer.from(reply))).toMatchObject({ rcode: 'SERVFAIL' });

  expect(egress.logs).toStrictEqual([
    'impd: egress: github.com for slot 1: nft exited 1: set is full',
  ]);
});

test('#startResolverServer answers over UDP, through an upstream whose truncated reply goes again over TCP', async () => {
  const ports = findFreePorts(2);

  const egress = buildStubEgressService({
    subnet: '127.0.0.0/16',
    verdicts: { 0: { 'registry.npmjs.org': 'admit' } },
  });

  const upstream = await startStubDnsUpstream({
    port: ports.take(),
    answers: [{ type: 'A', name: 'registry.npmjs.org', ttl: 60, data: '104.16.0.1' }],
    udp: 'truncate',
  });

  const handle = createQueryHandler({
    ...egress.deps,
    forward: createDnsForward(['127.0.0.1'], upstream.port),
  });

  const server = await startResolverServer(ports.take(), parseSubnet('127.0.0.0/16'), handle, {
    log: () => {},
  });

  onTestFinished(() => {
    server.stop();
  });

  // 127.0.0.2 is slot 0's guest in 127.0.0.0/16
  const reply = Promise.withResolvers<Uint8Array>();

  const client = await Bun.udpSocket({
    hostname: '127.0.0.2',
    socket: {
      data: (_socket, data) => {
        reply.resolve(new Uint8Array(data));
      },
    },
  });

  onTestFinished(() => {
    client.close();
  });

  client.send(
    buildMockDnsQuery({ name: 'registry.npmjs.org', type: 'A', id: 7 }),
    server.port,
    '127.0.0.1',
  );

  const received = await reply.promise;

  expect(dnsPacket.decode(Buffer.from(received))).toMatchObject({
    id: 7,
    answers: [{ type: 'A', data: '104.16.0.1' }],
  });

  expect(upstream.queries.map((query) => query.transport)).toStrictEqual(['udp', 'tcp']);
});

test('#startResolverServer answers a TCP query that comes in two writes', async () => {
  const egress = buildStubEgressService({
    subnet: '127.0.0.0/16',
    verdicts: { 0: { 'github.com': 'answer' } },
    upstream: { 'github.com': [{ type: 'A', name: 'github.com', ttl: 60, data: '140.82.112.3' }] },
  });

  const server = await startResolverServer(
    findFreePorts(1).take(),
    parseSubnet('127.0.0.0/16'),
    createQueryHandler(egress.deps),
    { log: () => {} },
  );

  onTestFinished(() => {
    server.stop();
  });

  const query = buildMockDnsQuery({ name: 'github.com', type: 'A', id: 7 });
  const length = Buffer.alloc(2);
  const framed = Promise.withResolvers<Buffer>();

  length.writeUInt16BE(query.byteLength, 0);

  const socket = connect(
    { host: '127.0.0.1', port: server.port, localAddress: '127.0.0.2' },
    () => {
      socket.write(length);
      socket.write(query);
    },
  );

  onTestFinished(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    framed.resolve(chunk);
  });

  const received = await framed.promise;

  // the stub upstream answers with the query's own id, which the handler keeps
  const reply = buildMockDnsReply(query, {
    answers: [{ type: 'A', name: 'github.com', ttl: 60, data: '140.82.112.3' }],
  });

  const expected = Buffer.alloc(2 + reply.byteLength);

  expected.writeUInt16BE(reply.byteLength, 0);
  expected.set(reply, 2);

  expect(received).toStrictEqual(expected);
});

test('#startResolverServer answers each of several TCP queries that share one write', async () => {
  const egress = buildStubEgressService({
    subnet: '127.0.0.0/16',
    verdicts: { 0: { 'a.test': 'answer', 'b.test': 'answer' } },
  });

  const server = await startResolverServer(
    findFreePorts(1).take(),
    parseSubnet('127.0.0.0/16'),
    createQueryHandler(egress.deps),
    { log: () => {} },
  );

  onTestFinished(() => {
    server.stop();
  });

  const queries = [
    buildMockDnsQuery({ name: 'a.test', type: 'A', id: 1 }),
    buildMockDnsQuery({ name: 'b.test', type: 'A', id: 2 }),
  ];

  const framed = Buffer.concat(
    queries.map((query) => {
      const message = Buffer.alloc(2 + query.byteLength);

      message.writeUInt16BE(query.byteLength, 0);
      message.set(query, 2);

      return message;
    }),
  );

  const socket = connect(
    { host: '127.0.0.1', port: server.port, localAddress: '127.0.0.2' },
    () => {
      socket.write(framed);
    },
  );

  onTestFinished(() => {
    socket.destroy();
  });

  await waitFor(() => {
    expect(egress.forwarded).toHaveLength(2);
  });

  expect(egress.forwarded.toSorted()).toStrictEqual(['a.test', 'b.test']);
});

test("#startResolverServer closes at once a TCP client past its slot's cap, and serves another slot's", async () => {
  const egress = buildStubEgressService({
    subnet: '127.0.0.0/16',
    verdicts: { 0: { 'github.com': 'answer' }, 1: { 'github.com': 'answer' } },
  });

  // UDP and TCP on one number: a picked port, not 0
  const server = await startResolverServer(
    findFreePorts(1).take(),
    parseSubnet('127.0.0.0/16'),
    createQueryHandler(egress.deps),
    { log: () => {}, limits: { idleS: 60, maxPerSlot: 2 } },
  );

  onTestFinished(() => {
    server.stop();
  });

  const query = buildMockDnsQuery({ name: 'github.com', type: 'A', id: 7 });
  const framed = Buffer.alloc(2 + query.byteLength);

  framed.writeUInt16BE(query.byteLength, 0);
  framed.set(query, 2);

  // slot 0's guest is 127.0.0.2, slot 1's 127.0.0.6: each client asks once,
  // and settles on its reply or on its close, whichever comes first
  const outcomes = await Promise.all(
    ['127.0.0.2', '127.0.0.2', '127.0.0.2', '127.0.0.6'].map((from) => {
      const outcome = Promise.withResolvers<'answered' | 'closed'>();

      const socket = connect({ host: '127.0.0.1', port: server.port, localAddress: from }, () => {
        socket.write(framed);
      });

      onTestFinished(() => {
        socket.destroy();
      });

      socket.on('error', () => {});

      socket.once('data', () => {
        outcome.resolve('answered');
      });

      socket.once('close', () => {
        outcome.resolve('closed');
      });

      return outcome.promise;
    }),
  );

  expect(outcomes.slice(0, 3).toSorted()).toStrictEqual(['answered', 'answered', 'closed']);
  expect(outcomes[3]).toBe('answered');
});

// Bun checks socket deadlines on a sweep of about four seconds, so a 1 s
// idleS closes the client after four to eight
test('#startResolverServer closes a TCP client idle past idleS', async () => {
  const ports = findFreePorts(2);

  const egress = buildStubEgressService({
    subnet: '127.0.0.0/16',
    verdicts: { 0: { 'github.com': 'answer' } },
  });

  // idleS is whole seconds, so 1 is the shortest
  const short = await startResolverServer(
    ports.take(),
    parseSubnet('127.0.0.0/16'),
    createQueryHandler(egress.deps),
    { log: () => {}, limits: { idleS: 1, maxPerSlot: 2 } },
  );

  onTestFinished(() => {
    short.stop();
  });

  // the control: a client of the same age that may idle for a minute
  const long = await startResolverServer(
    ports.take(),
    parseSubnet('127.0.0.0/16'),
    createQueryHandler(egress.deps),
    { log: () => {}, limits: { idleS: 60, maxPerSlot: 2 } },
  );

  onTestFinished(() => {
    long.stop();
  });

  const closed = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();

  // slot 0's guest is 127.0.0.2
  const idle = connect({ host: '127.0.0.1', port: short.port, localAddress: '127.0.0.2' });

  onTestFinished(() => {
    idle.destroy();
  });

  idle.on('error', () => {});

  idle.once('close', () => {
    closed.resolve();
  });

  const control = connect(
    { host: '127.0.0.1', port: long.port, localAddress: '127.0.0.2' },
    connected.resolve,
  );

  onTestFinished(() => {
    control.destroy();
  });

  await connected.promise;
  await closed.promise;

  const query = buildMockDnsQuery({ name: 'github.com', type: 'A', id: 7 });
  const framed = Buffer.alloc(2 + query.byteLength);
  const reply = Promise.withResolvers<Buffer>();

  framed.writeUInt16BE(query.byteLength, 0);
  framed.set(query, 2);

  control.once('data', (chunk: Buffer) => {
    reply.resolve(chunk);
  });

  control.write(framed);

  const answered = await reply.promise;

  expect(idle.destroyed).toBeTrue();
  expect(dnsPacket.decode(answered.subarray(2))).toMatchObject({ id: 7, rcode: 'NOERROR' });
}, 15_000);

test('#startResolverServer stays up when a guest goes before its reply, and logs nothing of the ICMP error', async () => {
  const ports = findFreePorts(1);
  const logs: string[] = [];
  const errors: unknown[] = [];
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  const report = createSocketErrorReport(
    (message) => {
      logs.push(message);
    },
    () => 0,
  );

  // holds the first reply until its guest has closed its port
  const server = await startResolverServer(
    ports.take(),
    parseSubnet('127.0.0.0/16'),
    async (_source, message) => {
      reached.resolve();

      await released.promise;

      return message;
    },
    {
      log: (message) => {
        logs.push(message);
      },
      reportError: (...args) => {
        errors.push(args.at(-1));

        report(...args);
      },
    },
  );

  onTestFinished(() => {
    server.stop();
  });

  const gone = await Bun.udpSocket({ hostname: '127.0.0.2' });

  gone.send(buildMockDnsQuery({ name: 'a.example', type: 'A' }), server.port, '127.0.0.1');

  await reached.promise;

  gone.close();
  released.resolve();

  await waitFor(() => {
    expect(errors).not.toBeEmpty();
  });

  const reply = Promise.withResolvers<Uint8Array>();

  const client = await Bun.udpSocket({
    hostname: '127.0.0.2',
    socket: {
      data: (_socket, data) => {
        reply.resolve(new Uint8Array(data));
      },
    },
  });

  onTestFinished(() => {
    client.close();
  });

  const query = buildMockDnsQuery({ name: 'b.example', type: 'A' });

  client.send(query, server.port, '127.0.0.1');

  const answered = await reply.promise;

  expect(answered).toStrictEqual(query);
  expect(logs).toStrictEqual([]);
});

test('#createSocketErrorReport logs nothing of an ICMP error or an unreachable guest', () => {
  const logs: string[] = [];

  const report = createSocketErrorReport(
    (message) => {
      logs.push(message);
    },
    () => 0,
  );

  report(
    Object.assign(new Error('EHOSTDOWN: host is down, recv'), {
      code: 'EHOSTDOWN',
      errqueue: true,
    }),
  );

  report(
    Object.assign(new Error('ECONNREFUSED: connection refused, recv'), { code: 'ECONNREFUSED' }),
  );

  report(
    Object.assign(new Error('EHOSTUNREACH: no route to host, send'), { code: 'EHOSTUNREACH' }),
  );

  report(
    Object.assign(new Error('ENETUNREACH: network is unreachable, send'), { code: 'ENETUNREACH' }),
  );

  expect(logs).toStrictEqual([]);
});

test('#createSocketErrorReport logs another socket error once a minute at most, with a count of the rest', () => {
  const logs: string[] = [];
  const clock = { now: 0 };

  const report = createSocketErrorReport(
    (message) => {
      logs.push(message);
    },
    () => clock.now,
  );

  const other = Object.assign(new Error('ENOBUFS: no buffer space available, send'), {
    code: 'ENOBUFS',
  });

  report(other);

  clock.now = 30_000;

  report(other);
  report(other);

  clock.now = 60_000;

  report(other);

  expect(logs).toStrictEqual([
    'impd: egress: resolver socket: ENOBUFS: no buffer space available, send',
    'impd: egress: resolver socket: ENOBUFS: no buffer space available, send (2 more since the last)',
  ]);
});

test('#createSocketErrorReport logs an error that carries no code', () => {
  const logs: string[] = [];

  const report = createSocketErrorReport(
    (message) => {
      logs.push(message);
    },
    () => 0,
  );

  report('socket closed');

  expect(logs).toStrictEqual(['impd: egress: resolver socket: socket closed']);
});
