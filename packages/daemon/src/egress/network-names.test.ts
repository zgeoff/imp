import { expect, test } from 'bun:test';
import { parseSubnet } from '../net/addressing';
import { buildMockNetworkMember } from '../test-utils/build-mock-network-member';
import { resolveNetworkName } from './network-names';

test('it answers a peer by its name under the network', () => {
  const view = {
    names: new Set(['lab']),
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      buildMockNetworkMember({ network: 'lab', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
    ],
  };

  const answer = resolveNetworkName(view, parseSubnet('10.66.0.0/16'), {
    slot: 0,
    name: 'db.lab.internal',
    type: 'A',
  });

  expect(answer).toStrictEqual({
    kind: 'records',
    records: [{ type: 'A', name: 'db.lab.internal', ttl: 5, data: '10.66.0.6' }],
  });
});

test('it answers a peer by its bare name', () => {
  const view = {
    names: new Set(['lab']),
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      buildMockNetworkMember({ network: 'lab', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
    ],
  };

  const answer = resolveNetworkName(view, parseSubnet('10.66.0.0/16'), {
    slot: 0,
    name: 'db',
    type: 'A',
  });

  expect(answer).toStrictEqual({
    kind: 'records',
    records: [{ type: 'A', name: 'db', ttl: 5, data: '10.66.0.6' }],
  });
});

// web and db share lab, db and cache share ops, slot 3 is on neither, and
// empty has no members
test.each([
  [0, 'cache.ops.internal'],
  [0, 'cache.lab.internal'],
  [3, 'db.lab.internal'],
  [0, 'nothing.lab.internal'],
  [0, 'lab.internal'],
  [0, 'a.db.lab.internal'],
  [0, 'db.empty.internal'],
])('it answers NXDOMAIN to slot %p for %p, a name under a network it may not see', (slot, name) => {
  const view = {
    names: new Set(['lab', 'ops', 'empty']),
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      buildMockNetworkMember({ network: 'ops', name: 'cache', slot: 2, guestIp: '10.66.0.10' }),
      buildMockNetworkMember({ network: 'ops', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
    ],
  };

  expect(
    resolveNetworkName(view, parseSubnet('10.66.0.0/16'), { slot, name, type: 'A' }),
  ).toStrictEqual({ kind: 'nxdomain' });
});

// web and db share lab; cache is on ops, which web is not on
test.each([
  [0, 'metadata.google.internal'],
  [0, 'db.corp.internal'],
  [0, 'internal'],
  [0, 'cache'],
  [3, 'db'],
  [0, 'example.com'],
])('it passes on slot %p asking for %p, a name of no network on the host', (slot, name) => {
  const view = {
    names: new Set(['lab', 'ops']),
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      buildMockNetworkMember({ network: 'ops', name: 'cache', slot: 2, guestIp: '10.66.0.10' }),
    ],
  };

  expect(
    resolveNetworkName(view, parseSubnet('10.66.0.0/16'), { slot, name, type: 'A' }),
  ).toBeNull();
});

test('it answers no data, not NXDOMAIN, for another type of a peer', () => {
  const view = {
    names: new Set(['lab']),
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      buildMockNetworkMember({ network: 'lab', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
    ],
  };

  const answer = resolveNetworkName(view, parseSubnet('10.66.0.0/16'), {
    slot: 0,
    name: 'db.lab.internal',
    type: 'AAAA',
  });

  expect(answer).toStrictEqual({ kind: 'records', records: [] });
});

// db shares lab with web and ops with cache
test.each([
  [1, '10.0.66.10.in-addr.arpa', 'cache.ops.internal'],
  [0, '6.0.66.10.in-addr.arpa', 'db.lab.internal'],
  [2, '6.0.66.10.in-addr.arpa', 'db.ops.internal'],
])(
  'it answers slot %p for %p with the peer name %p of the network they share',
  (slot, name, data) => {
    const view = {
      names: new Set(['lab', 'ops']),
      members: [
        buildMockNetworkMember({ network: 'lab', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
        buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
        buildMockNetworkMember({ network: 'ops', name: 'cache', slot: 2, guestIp: '10.66.0.10' }),
        buildMockNetworkMember({ network: 'ops', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
      ],
    };

    expect(
      resolveNetworkName(view, parseSubnet('10.66.0.0/16'), { slot, name, type: 'PTR' }),
    ).toStrictEqual({ kind: 'records', records: [{ type: 'PTR', name, ttl: 5, data }] });
  },
);

test('it names a peer once for each network the two share', () => {
  const view = {
    names: new Set(['lab', 'ops']),
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      buildMockNetworkMember({ network: 'ops', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
      buildMockNetworkMember({ network: 'ops', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
    ],
  };

  const answer = resolveNetworkName(view, parseSubnet('10.66.0.0/16'), {
    slot: 0,
    name: '6.0.66.10.in-addr.arpa',
    type: 'PTR',
  });

  expect(answer).toStrictEqual({
    kind: 'records',
    records: [
      { type: 'PTR', name: '6.0.66.10.in-addr.arpa', ttl: 5, data: 'db.lab.internal' },
      { type: 'PTR', name: '6.0.66.10.in-addr.arpa', ttl: 5, data: 'db.ops.internal' },
    ],
  });
});

test('it answers no data for another type of a peer address', () => {
  const view = {
    names: new Set(['lab']),
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      buildMockNetworkMember({ network: 'lab', name: 'db', slot: 1, guestIp: '10.66.0.6' }),
    ],
  };

  const answer = resolveNetworkName(view, parseSubnet('10.66.0.0/16'), {
    slot: 0,
    name: '6.0.66.10.in-addr.arpa',
    type: 'A',
  });

  expect(answer).toStrictEqual({ kind: 'records', records: [] });
});

// cache, on ops, is no peer of web
test.each([
  ['10.0.66.10.in-addr.arpa', 'PTR'],
  ['0.66.10.in-addr.arpa', 'PTR'],
  ['66.10.in-addr.arpa', 'SOA'],
])('it keeps %p %p in impd as NXDOMAIN, a reverse name of the subnet', (name, type) => {
  const view = {
    names: new Set(['lab', 'ops']),
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
      buildMockNetworkMember({ network: 'ops', name: 'cache', slot: 2, guestIp: '10.66.0.10' }),
    ],
  };

  expect(
    resolveNetworkName(view, parseSubnet('10.66.0.0/16'), { slot: 0, name, type }),
  ).toStrictEqual({ kind: 'nxdomain' });
});

test.each([
  ['1.1.1.1.in-addr.arpa'],
  ['10.in-addr.arpa'],
  ['1.0.67.10.in-addr.arpa'],
  ['5.1.0.66.10.in-addr.arpa'],
])('it passes on %p, a reverse name outside the subnet', (name) => {
  const view = {
    names: new Set(['lab']),
    members: [
      buildMockNetworkMember({ network: 'lab', name: 'web', slot: 0, guestIp: '10.66.0.2' }),
    ],
  };

  expect(
    resolveNetworkName(view, parseSubnet('10.66.0.0/16'), { slot: 0, name, type: 'PTR' }),
  ).toBeNull();
});
