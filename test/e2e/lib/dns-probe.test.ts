import { expect, test } from 'bun:test';
import * as dnsPacket from 'dns-packet';
import { buildTcpQueryOctal, parseTcpReplyHex } from './dns-probe';

test('#buildTcpQueryOctal frames an A query with its length, as octal escapes', () => {
  const octal = buildTcpQueryOctal('example.org');

  const bytes = Buffer.from(
    octal
      .split('\\')
      .slice(1)
      .map((digits) => Number.parseInt(digits, 8)),
  );

  const query = dnsPacket.decode(bytes.subarray(2));

  expect(bytes.readUInt16BE(0)).toBe(bytes.byteLength - 2);
  expect(query.questions).toStrictEqual([{ name: 'example.org', type: 'A', class: 'IN' }]);
  expect(query.additionals?.map((record) => record.type)).toStrictEqual(['OPT']);
});

test('#parseTcpReplyHex reads a REFUSED reply and its Extended DNS Error', () => {
  // the encoder takes the rcode in the flags' low bits (5 is REFUSED), and no
  // EDE option: the reply ends with an empty OPT record, whose rdlength
  // becomes 6 for option 15 of length 2, info code 18
  const encoded = dnsPacket.encode({
    type: 'response',
    id: 26,
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE | 5,
    questions: [{ name: 'example.org', type: 'A' }],
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
  });

  const reply = Buffer.concat([encoded.subarray(0, -2), Buffer.from([0, 6, 0, 15, 0, 2, 0, 18])]);
  const framed = Buffer.concat([Buffer.from([0, reply.byteLength]), reply]);
  const hex = [...framed].map((byte) => ` ${byte.toString(16).padStart(2, '0')}`).join('');
  const parsed = parseTcpReplyHex(`${hex}\n`);

  expect(parsed.reply).toMatchObject({ rcode: 'REFUSED', answers: [] });
  expect(parsed.lastOption).toStrictEqual([15, 18]);
});
