import { expect, test } from 'bun:test';
import type { NetworkMember } from '../db/networks';
import { parseSubnet } from '../net/addressing';
import { resolveNetworkName } from './network-names';

const SUBNET = parseSubnet('10.66.0.0/16');

function buildMember(network: string, name: string, slot: number): NetworkMember {
  return { network, impId: name, name, slot, guestIp: `10.66.0.${String(slot * 4 + 2)}` };
}

// web and db share lab, db and cache share ops, and slot 3 is on neither
const MEMBERS = [
  buildMember('lab', 'db', 1),
  buildMember('lab', 'web', 0),
  buildMember('ops', 'cache', 2),
  buildMember('ops', 'db', 1),
];

function resolveAs(slot: number, name: string, type = 'A') {
  return resolveNetworkName(MEMBERS, SUBNET, { slot, name, type });
}

test('a peer has an address under its network, and by its bare name', () => {
  const full = resolveAs(0, 'db.lab.internal');
  const bare = resolveAs(0, 'db');

  expect(full).toEqual({
    kind: 'records',
    records: [{ type: 'A', name: 'db.lab.internal', ttl: 5, data: '10.66.0.6' }],
  });

  expect(bare).toEqual({
    kind: 'records',
    records: [{ type: 'A', name: 'db', ttl: 5, data: '10.66.0.6' }],
  });
});

test('a name of the zone the guest shares no network with does not exist', () => {
  const answers = [
    // web is not on ops
    resolveAs(0, 'cache.ops.internal'),

    // cache is on ops, not lab
    resolveAs(0, 'cache.lab.internal'),

    // slot 3 is on no network
    resolveAs(3, 'db.lab.internal'),
    resolveAs(0, 'nothing.lab.internal'),
    resolveAs(0, 'lab.internal'),
    resolveAs(0, 'internal'),
    resolveAs(0, 'a.db.lab.internal'),
  ];

  expect(answers).toEqual(Array.from({ length: answers.length }, () => ({ kind: 'nxdomain' })));
});

test('a bare name that is no peer goes upstream', () => {
  const answers = [resolveAs(0, 'cache'), resolveAs(3, 'db'), resolveAs(0, 'example.com')];

  expect(answers).toEqual([null, null, null]);
});

test('another type for a peer is no data, not NXDOMAIN', () => {
  const answer = resolveAs(0, 'db.lab.internal', 'AAAA');

  expect(answer).toEqual({ kind: 'records', records: [] });
});

test('a peer address names the peer on each network the two share', () => {
  const fromDb = resolveAs(1, '10.0.66.10.in-addr.arpa', 'PTR');
  const fromWeb = resolveAs(0, '6.0.66.10.in-addr.arpa', 'PTR');
  const fromCache = resolveAs(2, '6.0.66.10.in-addr.arpa', 'PTR');

  expect(fromDb).toEqual({
    kind: 'records',
    records: [{ type: 'PTR', name: '10.0.66.10.in-addr.arpa', ttl: 5, data: 'cache.ops.internal' }],
  });

  expect(fromWeb).toEqual({
    kind: 'records',
    records: [{ type: 'PTR', name: '6.0.66.10.in-addr.arpa', ttl: 5, data: 'db.lab.internal' }],
  });

  expect(fromCache).toEqual({
    kind: 'records',
    records: [{ type: 'PTR', name: '6.0.66.10.in-addr.arpa', ttl: 5, data: 'db.ops.internal' }],
  });
});

test('every reverse name of the subnet stays in impd', () => {
  const answers = [
    // not a peer of web
    resolveAs(0, '10.0.66.10.in-addr.arpa', 'PTR'),
    resolveAs(0, '0.66.10.in-addr.arpa', 'PTR'),
    resolveAs(0, '66.10.in-addr.arpa', 'SOA'),
  ];

  expect(answers).toEqual(Array.from({ length: answers.length }, () => ({ kind: 'nxdomain' })));
});

test('a reverse name outside the subnet goes upstream', () => {
  const answers = [
    resolveAs(0, '1.1.1.1.in-addr.arpa', 'PTR'),
    resolveAs(0, '10.in-addr.arpa', 'PTR'),
    resolveAs(0, '1.0.67.10.in-addr.arpa', 'PTR'),
  ];

  expect(answers).toEqual([null, null, null]);
});
