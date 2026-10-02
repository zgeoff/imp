import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import * as dnsPacket from 'dns-packet';
import type { Answer, DecodedPacket } from 'dns-packet';
import { parseSubnet } from '../net/addressing';
import { findFreePorts } from '../net/test-free-ports';
import { createDnsForward } from './dns-upstream';
import { createQueryHandler, startResolverServer } from './egress-resolver';
import type { QueryVerdict, ResolverDeps } from './egress-resolver';
import type { AddressAnswer } from './egress-sets';

// slot 1's guest is 10.66.0.6; 10.66.0.7 is the same /30's broadcast
const GUEST = '10.66.0.6';

function buildQuery(name: string, type: 'A' | 'AAAA' = 'A', edns = true): Uint8Array {
  return dnsPacket.encode({
    type: 'query',
    id: 4242,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ name, type }],
    ...(edns && {
      additionals: [
        {
          type: 'OPT',
          name: '.',
          udpPayloadSize: 1232,
          extendedRcode: 0,
          ednsVersion: 0,
          flags: 0,
          flag_do: false,
          options: [],
        },
      ],
    }),
  });
}

function buildAnswer(query: Uint8Array, answers: readonly Answer[]): Uint8Array {
  const decoded = dnsPacket.decode(Buffer.from(query));

  return dnsPacket.encode({
    type: 'response',
    id: decoded.id ?? 0,
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
    questions: decoded.questions ?? [],
    answers: [...answers],
  });
}

function readReply(reply: Uint8Array): DecodedPacket & { readonly rcode?: string } {
  return dnsPacket.decode(Buffer.from(reply));
}

// RFC 8914 option 15, the last six bytes of the reply's OPT record, as its
// info code; dns-packet's types know no such option
function readEde(reply: Uint8Array): number | null {
  const opt = readReply(reply).additionals?.find((record) => record.type === 'OPT');
  const tail = Buffer.from(reply.subarray(-6));

  return opt === undefined || tail.readUInt16BE(0) !== 15 ? null : tail.readUInt16BE(4);
}

const NPM_ANSWERS: readonly Answer[] = [
  { type: 'CNAME', name: 'registry.npmjs.org', ttl: 300, data: 'npm.cdn.test' },
  { type: 'A', name: 'npm.cdn.test', ttl: 200_000, data: '104.16.0.1' },
  { type: 'A', name: 'npm.cdn.test', ttl: 60, data: '104.16.0.2' },
  { type: 'A', name: 'smuggled.test', ttl: 60, data: '6.6.6.6' },
];

function setupHandler(overrides: Partial<ResolverDeps> = {}) {
  const forwarded: string[] = [];
  const admitted: { names: readonly string[]; answers: readonly AddressAnswer[] }[] = [];

  const verdicts: Readonly<Record<string, QueryVerdict>> = {
    'registry.npmjs.org': 'admit',
    'api.github.com': 'answer',
  };

  const deps: ResolverDeps = {
    subnet: parseSubnet('10.66.0.0/16'),
    checkName: (slot, name) => {
      const verdict = slot === 1 ? (verdicts[name] ?? 'refuse') : null;

      return Promise.resolve(verdict);
    },
    writeAnswers: (_slot, names, answers) => {
      admitted.push({ names, answers });

      return Promise.resolve();
    },
    forward: (query) => {
      forwarded.push(readReply(query).questions?.[0]?.name ?? '');

      return Promise.resolve(buildAnswer(query, NPM_ANSWERS));
    },
    maxTtlS: 86_400,
    rate: { burst: 100, perSecond: 10 },
    now: () => 0,
    log: () => {},
    ...overrides,
  };

  const handle = createQueryHandler(deps);

  // the decoded reply to one query for `name` from `source`
  const sendQuery = async (name: string, source = GUEST, type: 'A' | 'AAAA' = 'A') => {
    const reply = await handle(source, buildQuery(name, type));

    return readReply(reply);
  };

  return { handle, sendQuery, forwarded, admitted };
}

test('an allowed name: the CNAME chain and its A records go in, and the TTLs drop', async () => {
  const ctx = setupHandler();

  const reply = await ctx.sendQuery('Registry.NPMJS.org.');

  const ttls = reply.answers?.map((record) => ('ttl' in record ? record.ttl : null));

  expect(ctx.admitted).toEqual([
    {
      names: ['registry.npmjs.org', 'npm.cdn.test'],
      answers: [
        { address: '104.16.0.1', ttlS: 200_000 },
        { address: '104.16.0.2', ttlS: 60 },
      ],
    },
  ]);

  expect(ttls).toEqual([300, 86_400, 60, 60]);
});

test('the reply waits for the addresses to be in nft', async () => {
  const gate = Promise.withResolvers<void>();
  const ctx = setupHandler({ writeAnswers: () => gate.promise });
  const state = { replied: false };

  const runQuery = async () => {
    await ctx.sendQuery('registry.npmjs.org');

    state.replied = true;
  };

  const reply = runQuery();

  await Bun.sleep(20);

  expect(state.replied).toBeFalse();

  gate.resolve();

  await reply;

  expect(state.replied).toBeTrue();
});

test('a refused name never goes upstream, and gets REFUSED with EDE 18', async () => {
  const ctx = setupHandler();

  const reply = await ctx.handle(GUEST, buildQuery('example.org'));

  const decoded = readReply(reply);

  expect(decoded.rcode).toBe('REFUSED');
  expect(readEde(reply)).toBe(18);
  expect(decoded.questions).toEqual([{ name: 'example.org', type: 'A', class: 'IN' }]);
  expect(ctx.forwarded).toEqual([]);

  // without EDNS in the query, no OPT record in the reply
  const query = buildQuery('example.org', 'A', false);

  const plain = await ctx.handle(GUEST, query);

  const plainDecoded = readReply(plain);

  expect(plainDecoded.rcode).toBe('REFUSED');
  expect(readEde(plain)).toBeNull();
});

test('another address of the slot, or a slot that is not filtered, is refused', async () => {
  const ctx = setupHandler();

  for (const source of ['10.66.0.7', '10.66.0.5', '10.66.0.2', '192.0.2.1']) {
    const reply = await ctx.sendQuery('registry.npmjs.org', source);

    expect({ source, rcode: reply.rcode }).toEqual({ source, rcode: 'REFUSED' });
  }

  expect(ctx.forwarded).toEqual([]);
});

test('a query with two questions is refused', async () => {
  const ctx = setupHandler();

  const twice = dnsPacket.encode({
    type: 'query',
    id: 1,
    questions: [
      { name: 'registry.npmjs.org', type: 'A' },
      { name: 'example.org', type: 'A' },
    ],
  });

  const reply = await ctx.handle(GUEST, twice);

  expect(readReply(reply).rcode).toBe('REFUSED');
  expect(ctx.forwarded).toEqual([]);
});

test('AAAA gets an empty answer, and a host the broker serves adds nothing', async () => {
  const ctx = setupHandler();

  const v6 = await ctx.sendQuery('registry.npmjs.org', GUEST, 'AAAA');

  expect(v6.rcode).toBe('NOERROR');
  expect(v6.answers).toEqual([]);

  await ctx.sendQuery('api.github.com');

  expect(ctx.forwarded).toEqual(['api.github.com']);
  expect(ctx.admitted).toEqual([]);
});

test('past the burst a slot is refused until its bucket refills', async () => {
  const clock = { now: 0 };
  const ctx = setupHandler({ rate: { burst: 2, perSecond: 1 }, now: () => clock.now });
  const rcodes = [];

  for (let query = 0; query < 3; query += 1) {
    const reply = await ctx.sendQuery('registry.npmjs.org');

    rcodes.push(reply.rcode);
  }

  clock.now = 1000;

  const refilled = await ctx.sendQuery('registry.npmjs.org');

  rcodes.push(refilled.rcode);

  expect(rcodes).toEqual(['NOERROR', 'NOERROR', 'REFUSED', 'NOERROR']);
});

test('a rate-limited query is plain REFUSED, with no EDE 18', async () => {
  const ctx = setupHandler({ rate: { burst: 1, perSecond: 1 } });

  await ctx.handle(GUEST, buildQuery('registry.npmjs.org'));

  const limited = await ctx.handle(GUEST, buildQuery('registry.npmjs.org'));
  const denied = await setupHandler().handle(GUEST, buildQuery('denied.test'));

  expect(readReply(limited).rcode).toBe('REFUSED');
  expect(readEde(limited)).toBeNull();
  expect(readEde(denied)).toBe(18);
});

test('replies carry at most maxTtlS', async () => {
  const ctx = setupHandler({ maxTtlS: 300 });

  const reply = await ctx.sendQuery('registry.npmjs.org');

  expect(reply.answers?.map((record) => (record.type === 'OPT' ? null : record.ttl))).toEqual([
    300, 300, 60, 60,
  ]);
});

test('an upstream that fails, or a set that cannot take the answer, is SERVFAIL', async () => {
  const down = setupHandler({ forward: () => Promise.reject(new Error('no upstream answered')) });

  const noUpstream = await down.sendQuery('registry.npmjs.org');

  expect(noUpstream.rcode).toBe('SERVFAIL');

  const full = setupHandler({ writeAnswers: () => Promise.reject(new Error('nft exited 1')) });

  const noSet = await full.sendQuery('registry.npmjs.org');

  expect(noSet.rcode).toBe('SERVFAIL');
});

// a fake upstream on loopback: UDP replies truncated, TCP replies whole. It
// takes a picked port: UDP on port 0 and then TCP on the same number races
// any TCP socket that already holds it.
async function startFakeUpstream(listenPort: number) {
  const udp = await Bun.udpSocket({
    hostname: '127.0.0.1',
    port: listenPort,
    socket: {
      data: (socket, data, port, address) => {
        const query = new Uint8Array(data);

        const decoded = dnsPacket.decode(Buffer.from(query));

        const truncated = dnsPacket.encode({
          type: 'response',
          id: decoded.id ?? 0,
          flags: dnsPacket.TRUNCATED_RESPONSE,
          questions: decoded.questions ?? [],
        });

        socket.send(truncated, port, address);
      },
    },
  });

  const tcp = Bun.listen({
    hostname: '127.0.0.1',
    port: udp.port,
    socket: {
      data: (socket, chunk) => {
        const query = new Uint8Array(chunk.subarray(2));

        const reply = buildAnswer(query, NPM_ANSWERS);
        const framed = Buffer.alloc(2 + reply.byteLength);

        framed.writeUInt16BE(reply.byteLength, 0);
        framed.set(reply, 2);
        socket.write(framed);
      },
    },
  });

  return {
    port: udp.port,
    [Symbol.dispose]: () => {
      udp.close();
      tcp.stop(true);
    },
  };
}

test('over UDP and TCP on loopback, with a truncated upstream reply retried over TCP', async () => {
  const ports = findFreePorts(2);

  using upstream = await startFakeUpstream(ports.take());

  const handle = createQueryHandler({
    subnet: parseSubnet('127.0.0.0/16'),
    checkName: () => Promise.resolve('admit'),
    writeAnswers: () => Promise.resolve(),
    forward: createDnsForward(['127.0.0.1'], upstream.port),
    maxTtlS: 86_400,
    rate: { burst: 100, perSecond: 100 },
    now: Date.now,
    log: () => {},
  });

  const server = await startResolverServer(ports.take(), parseSubnet('127.0.0.0/16'), handle);

  try {
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

    client.send(buildQuery('registry.npmjs.org'), server.port, '127.0.0.1');

    const udpBytes = await reply.promise;

    const udpReply = readReply(udpBytes);

    client.close();

    expect(udpReply.answers?.filter((record) => record.type === 'A')).toHaveLength(3);

    // the same over TCP, in two writes
    const framed = Promise.withResolvers<Buffer>();
    const query = buildQuery('registry.npmjs.org');
    const length = Buffer.alloc(2);

    length.writeUInt16BE(query.byteLength, 0);

    const socket = connect(
      { host: '127.0.0.1', port: server.port, localAddress: '127.0.0.2' },
      () => {
        socket.write(length);
        socket.write(query);
      },
    );

    socket.on('data', (chunk: Buffer) => {
      framed.resolve(chunk);
      socket.end();
    });

    const tcpBytes = await framed.promise;

    const tcpReply = readReply(tcpBytes.subarray(2));

    expect(tcpReply.answers?.filter((record) => record.type === 'A')).toHaveLength(3);
  } finally {
    server.stop();
  }
});

test('upstream queries carry a fresh id, and the guest gets its own back', async () => {
  const seenIds: number[] = [];

  const upstream = await Bun.udpSocket({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket, data, port, address) => {
        const query = new Uint8Array(data);

        seenIds.push(dnsPacket.decode(Buffer.from(query)).id ?? 0);
        socket.send(buildAnswer(query, NPM_ANSWERS), port, address);
      },
    },
  });

  try {
    const forward = createDnsForward(['127.0.0.1'], upstream.port);

    const first = await forward(buildQuery('registry.npmjs.org'));
    const second = await forward(buildQuery('registry.npmjs.org'));

    expect(readReply(first).id).toBe(4242);
    expect(readReply(second).id).toBe(4242);
    expect(seenIds).toHaveLength(2);
    expect(seenIds[0]).not.toBe(seenIds[1]);
  } finally {
    upstream.close();
  }
});

// a TCP client from `from` that resolves `closed` when the resolver ends it
function openTcpClient(port: number, from: string) {
  const closed = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port, localAddress: from }, connected.resolve);

  socket.on('error', () => {});

  socket.once('close', () => {
    closed.resolve();
  });

  return { socket, connected: connected.promise, closed: closed.promise };
}

test('the TCP side closes an idle client and caps the clients of one slot', async () => {
  const handle = createQueryHandler({
    subnet: parseSubnet('127.0.0.0/16'),
    checkName: () => Promise.resolve('refuse'),
    writeAnswers: () => Promise.resolve(),
    forward: () => Promise.reject(new Error('no upstream')),
    maxTtlS: 300,
    rate: { burst: 100, perSecond: 100 },
    now: Date.now,
    log: () => {},
  });

  // UDP and TCP on one number: a picked port, not 0 (see startFakeUpstream)
  const server = await startResolverServer(
    findFreePorts(1).take(),
    parseSubnet('127.0.0.0/16'),
    handle,
    {
      idleS: 1,
      maxPerSlot: 2,
    },
  );

  try {
    const first = openTcpClient(server.port, '127.0.0.2');
    const second = openTcpClient(server.port, '127.0.0.2');

    await Promise.all([first.connected, second.connected]);

    // slot 0 is full; slot 1's guest still gets in
    const third = openTcpClient(server.port, '127.0.0.2');
    const other = openTcpClient(server.port, '127.0.0.6');

    await third.closed;

    expect(other.socket.destroyed).toBeFalse();

    // the idle clients go
    await Promise.all([first.closed, second.closed, other.closed]);
  } finally {
    server.stop();
  }
}, 15_000);
