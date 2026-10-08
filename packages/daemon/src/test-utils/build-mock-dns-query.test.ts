import { expect, test } from 'bun:test';
import { buildMockDnsQuery } from './build-mock-dns-query';

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
