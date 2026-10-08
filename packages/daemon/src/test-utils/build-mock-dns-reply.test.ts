import { expect, test } from 'bun:test';
import { buildMockDnsQuery } from './build-mock-dns-query';
import { buildMockDnsReply } from './build-mock-dns-reply';

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

test('it builds a default dns reply', () => {
  const query = buildMockDnsQuery({ name: 'a.test', type: 'A', id: 0x12_34, edns: false });

  expect(Buffer.from(buildMockDnsReply(query)).toString('hex')).toBe(
    '123481800001000000000000016104746573740000010001',
  );
});

test('it applies overrides on top of the defaults', () => {
  const query = buildMockDnsQuery({ name: 'a.test', type: 'A', id: 0x12_34, edns: false });

  const reply = buildMockDnsReply(query, {
    answers: [{ type: 'A', name: 'a.test', ttl: 60, data: '192.0.2.1' }],
    id: 0x00_07,
  });

  expect(Buffer.from(reply).toString('hex')).toBe(
    '000781800001000100000000016104746573740000010001016104746573740000010001' +
      '0000003c0004c0000201',
  );
});
