import * as dnsPacket from 'dns-packet';
import type { Packet } from 'dns-packet';

// A DNS query over TCP from a busybox guest, which has nc and printf but no
// dig: the query goes out as a printf of octal escapes, the reply comes back
// as od's hex.

// an A query for the name with an EDNS OPT record, length-framed for TCP,
// as printf's octal escapes
export function buildTcpQueryOctal(name: string): string {
  const query = dnsPacket.encode({
    type: 'query',
    id: 26,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ name, type: 'A' }],
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

  const framed = Buffer.concat([Buffer.from([0, query.byteLength]), query]);

  return [...framed].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');
}

export interface TcpReply {
  readonly reply: Packet;

  // the OPT record's last option, read as an Extended DNS Error: its code
  // (15) and the error's info code
  readonly lastOption: readonly [number, number];
}

// od -An -tx1 of a length-framed reply that ends with an EDE option with no
// extra text
export function parseTcpReplyHex(hex: string): TcpReply {
  const bytes = Buffer.from(hex.replaceAll(/\s/gv, ''), 'hex').subarray(2);
  const tail = bytes.subarray(-6);

  return {
    reply: dnsPacket.decode(bytes),
    lastOption: [tail.readUInt16BE(0), tail.readUInt16BE(4)],
  };
}
