import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import * as dnsPacket from 'dns-packet';
import { buildMockDnsQuery, buildMockDnsReply } from '../test-utils/build-mock-dns-message';
import { EDE_PROHIBITED, RCODE, buildEmptyReply, buildLocalReply, readQuery } from './dns-messages';

test('#readQuery reads the id, name and type of a query with one question', () => {
  const query = readQuery(buildMockDnsQuery({ name: 'Example.COM', type: 'AAAA', id: 0x12_34 }));

  // the decoded packet carries every flag dns-packet reads
  expect(query).toMatchObject({
    id: 0x12_34,
    name: 'Example.COM',
    type: 'AAAA',
    packet: { type: 'query', questions: [{ name: 'Example.COM', type: 'AAAA', class: 'IN' }] },
  });
});

test('#readQuery reads nothing from bytes that are no DNS message', () => {
  expect(readQuery(Uint8Array.from([1, 2, 3]))).toBeNull();
});

test('#readQuery reads nothing from a reply', () => {
  const query = buildMockDnsQuery({ name: 'example.com', type: 'A' });

  expect(readQuery(buildMockDnsReply(query))).toBeNull();
});

test('#readQuery reads nothing from an opcode other than QUERY', () => {
  const update = buildMockDnsQuery({ name: 'example.com', type: 'A', edns: false });

  // opcode 5, UPDATE, in the high byte of the flags
  update[2] = (update[2] ?? 0) | 0x28;

  expect(readQuery(update)).toBeNull();
});

test('#readQuery reads nothing from a query with two questions', () => {
  const single = buildMockDnsQuery({ name: 'a.test', type: 'A', edns: false });
  const twice = Uint8Array.from([...single, ...single.subarray(12)]);

  twice[5] = 2;

  expect(readQuery(twice)).toBeNull();
});

test('#readQuery reads nothing from a query with no question', () => {
  expect(readQuery(Uint8Array.from([0x12, 0x34, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
});

test('#buildEmptyReply refuses with EDE 18 when the query spoke EDNS', () => {
  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 0x12_34 });
  const reply = buildEmptyReply(query, RCODE.refused, EDE_PROHIBITED);

  expect(Buffer.from(reply).toString('hex')).toBe(
    [
      '123481850001000000000001',
      '076578616d706c6503636f6d0000010001',
      '0000291000000000000006000f00020012',
    ].join(''),
  );
});

test('#buildEmptyReply refuses plainly when the query did not speak EDNS', () => {
  const query = buildMockDnsQuery({ name: 'example.com', type: 'A', id: 0x12_34, edns: false });
  const reply = buildEmptyReply(query, RCODE.refused, EDE_PROHIBITED);

  expect(Buffer.from(reply).toString('hex')).toBe(
    '123481850001000000000000076578616d706c6503636f6d0000010001',
  );
});

test('#buildEmptyReply answers NOERROR with no data and no OPT record without an EDE code', () => {
  const query = buildMockDnsQuery({ name: 'example.com', type: 'AAAA', id: 0x12_34 });
  const reply = buildEmptyReply(query, RCODE.noError);

  expect(Buffer.from(reply).toString('hex')).toBe(
    '123481800001000000000000076578616d706c6503636f6d00001c0001',
  );
});

test('#buildEmptyReply keeps RD off when the query had it off', () => {
  const query = buildMockDnsQuery({ name: 'a.test', type: 'A', id: 0x12_34, edns: false });

  query[2] = 0;

  const reply = buildEmptyReply(query, RCODE.servFail);

  expect(Buffer.from(reply).toString('hex')).toBe(
    '123480820001000000000000016104746573740000010001',
  );
});

test('#buildEmptyReply answers nothing to a message shorter than a header', () => {
  expect(buildEmptyReply(Uint8Array.from([0x12, 0x34, 1]), RCODE.refused)).toStrictEqual(
    new Uint8Array(),
  );
});

test('#buildEmptyReply leaves out a question that uses compression', () => {
  const query = Uint8Array.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1]);
  const reply = buildEmptyReply(query, RCODE.formErr);

  expect(Buffer.from(reply).toString('hex')).toBe('123481810000000000000000');
});

test('#buildEmptyReply leaves out a question that runs past the end', () => {
  const query = Uint8Array.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, 0x65, 0x78]);
  const reply = buildEmptyReply(query, RCODE.refused);

  expect(Buffer.from(reply).toString('hex')).toBe('123481850000000000000000');
});

test('#buildEmptyReply leaves out a question whose type and class are cut off', () => {
  const query = Uint8Array.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0x61, 0, 0, 1]);
  const reply = buildEmptyReply(query, RCODE.nxDomain);

  expect(Buffer.from(reply).toString('hex')).toBe('123481830000000000000000');
});

test('#buildLocalReply answers with authority, under the query id and question', () => {
  const query = readQuery(buildMockDnsQuery({ name: 'web.lab.internal', type: 'A', id: 0x12_34 }));

  invariant(query);

  const reply = dnsPacket.decode(
    Buffer.from(
      buildLocalReply(query, [{ type: 'A', name: 'web.lab.internal', ttl: 5, data: '10.66.0.2' }]),
    ),
  );

  expect(reply).toMatchObject({
    id: 0x12_34,
    type: 'response',
    flag_aa: true,
    flag_rd: true,
    flag_ra: true,
    rcode: 'NOERROR',
    questions: [{ name: 'web.lab.internal', type: 'A', class: 'IN' }],
    answers: [{ type: 'A', name: 'web.lab.internal', ttl: 5, class: 'IN', data: '10.66.0.2' }],
  });
});
