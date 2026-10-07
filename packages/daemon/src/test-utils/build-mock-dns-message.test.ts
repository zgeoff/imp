import { expect, test } from 'bun:test';
import { buildMockDnsQuery, buildMockDnsReply } from './build-mock-dns-message';

test('it builds a default dns query', () => {
  const query = buildMockDnsQuery({ name: 'example.com', type: 'A' });

  expect(Buffer.from(query.subarray(2)).toString('hex')).toBe(
    '01000001000000000001076578616d706c6503636f6d000001000100002904d0000000000000',
  );
});

test('it applies overrides on top of the defaults', () => {
  const query = buildMockDnsQuery({ name: 'example.com', type: 'AAAA', id: 0x12_34, edns: false });

  expect(Buffer.from(query).toString('hex')).toBe(
    '123401000001000000000000076578616d706c6503636f6d00001c0001',
  );
});

test('it encodes a query without EDNS as RFC 1035 lays it out', () => {
  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 0x12_34, edns: false });

  expect(Buffer.from(query).toString('hex')).toBe(
    '123401000001000000000000076578616d706c6503636f6d0000010001',
  );
});

test('it encodes a query with an EDNS OPT record of 1232 bytes', () => {
  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 0x12_34 });

  expect(Buffer.from(query).toString('hex')).toBe(
    '123401000001000000000001076578616d706c6503636f6d000001000100002904d0000000000000',
  );
});

test('it encodes a reply with a CNAME, an A and an AAAA record', () => {
  const query = buildMockDnsQuery({ name: 'www.example.com', type: 'A', id: 0x12_34, edns: false });

  const reply = buildMockDnsReply(query, {
    answers: [
      { type: 'CNAME', name: 'www.example.com', ttl: 300, data: 'example.com' },
      { type: 'A', name: 'example.com', ttl: 60, data: '93.184.215.14' },
      { type: 'AAAA', name: 'example.com', ttl: 60, data: '2606:2800:21f:cb07::1' },
    ],
  });

  expect(Buffer.from(reply).toString('hex')).toBe(
    [
      '123481800001000300000000',
      '03777777076578616d706c6503636f6d0000010001',
      '03777777076578616d706c6503636f6d00000500010000012c000d076578616d706c6503636f6d00',
      '076578616d706c6503636f6d00000100010000003c00045db8d70e',
      '076578616d706c6503636f6d00001c00010000003c001026062800021fcb070000000000000001',
    ].join(''),
  );
});

test('it puts records in the authority and additional sections, and sets TC and the id given', () => {
  const query = buildMockDnsQuery({ name: 'a.test', type: 'A', id: 0x12_34, edns: false });

  const reply = buildMockDnsReply(query, {
    authorities: [{ type: 'A', name: 'ns.test', ttl: 1, data: '10.0.0.1' }],
    additionals: [{ type: 'A', name: 'ns.test', ttl: 1, data: '10.0.0.2' }],
    truncated: true,
    id: 0xab_cd,
  });

  expect(Buffer.from(reply).toString('hex')).toBe(
    [
      'abcd83800001000000010001',
      '016104746573740000010001',
      '026e73047465737400000100010000000100040a000001',
      '026e73047465737400000100010000000100040a000002',
    ].join(''),
  );
});
