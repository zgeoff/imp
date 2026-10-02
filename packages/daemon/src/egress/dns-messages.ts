import * as dnsPacket from 'dns-packet';
import type { Answer, DecodedPacket } from 'dns-packet';

// DNS replies the resolver writes itself, byte by byte: dns-packet cannot
// encode an Extended DNS Error (RFC 8914).

const HEADER_BYTES = 12;
const QR = 0x80_00;
const OPCODE_MASK = 0x78_00;
const RD = 0x01_00;
const RA = 0x00_80;
const AA = 0x04_00;
const TYPE_OPT = 41;
const EDE_OPTION = 15;

export const RCODE = { noError: 0, formErr: 1, servFail: 2, nxDomain: 3, refused: 5 } as const;

// RFC 8914's "Prohibited": the name is outside the imp's policy
export const EDE_PROHIBITED = 18;

export interface DnsQuery {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly packet: DecodedPacket;
}

// The query's one question, or null for anything the resolver will not
// answer: not a query, an opcode other than QUERY, or not one question.
export function readQuery(message: Uint8Array): DnsQuery | null {
  let packet: DecodedPacket;

  try {
    packet = dnsPacket.decode(Buffer.from(message));
  } catch {
    return null;
  }

  const question = packet.questions?.[0];

  if (
    packet.flag_qr ||
    ((packet.flags ?? 0) & OPCODE_MASK) !== 0 ||
    packet.questions?.length !== 1 ||
    question === undefined
  ) {
    return null;
  }

  return { id: packet.id ?? 0, name: question.name, type: question.type, packet };
}

// A reply with no answers: REFUSED, with the EDE code when the query spoke
// EDNS, or an empty NOERROR (no data of this type). The question goes back
// when the query had exactly one that reads plainly.
export function buildEmptyReply(message: Uint8Array, rcode: number, ede?: number): Uint8Array {
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);

  if (message.byteLength < HEADER_BYTES) {
    return new Uint8Array();
  }

  const question = readQuestionBytes(message);
  const withEde = ede !== undefined && hasEdns(message);

  const opt = withEde
    ? [0, 0, TYPE_OPT, 0x10, 0x00, 0, 0, 0, 0, 0, 6, 0, EDE_OPTION, 0, 2, 0, ede]
    : [];

  const reply = new Uint8Array(HEADER_BYTES + question.byteLength + opt.length);
  const out = new DataView(reply.buffer);

  out.setUint16(0, view.getUint16(0));
  out.setUint16(2, QR | (view.getUint16(2) & RD) | RA | rcode);

  const questions = question.byteLength > 0 ? 1 : 0;
  const additionals = withEde ? 1 : 0;

  out.setUint16(4, questions);
  out.setUint16(10, additionals);
  reply.set(question, HEADER_BYTES);
  reply.set(opt, HEADER_BYTES + question.byteLength);

  return reply;
}

// impd's own answer, as the authority for the name
export function buildLocalReply(query: DnsQuery, answers: readonly Answer[]): Uint8Array {
  return dnsPacket.encode({
    type: 'response',
    id: query.id,
    flags: ((query.packet.flags ?? 0) & RD) | RA | AA,
    questions: query.packet.questions ?? [],
    answers: [...answers],
  });
}

// the first question's bytes, or none when it uses compression or runs
// past the end
function readQuestionBytes(message: Uint8Array): Uint8Array {
  let offset = HEADER_BYTES;

  while (offset < message.byteLength) {
    const length = message[offset] ?? 0;

    if (length === 0) {
      const end = offset + 1 + 4;

      return end <= message.byteLength ? message.slice(HEADER_BYTES, end) : new Uint8Array();
    }

    if (length >= 0xc0) {
      return new Uint8Array();
    }

    offset += 1 + length;
  }

  return new Uint8Array();
}

function hasEdns(message: Uint8Array): boolean {
  try {
    const packet = dnsPacket.decode(Buffer.from(message));

    return (packet.additionals ?? []).some((record) => record.type === 'OPT');
  } catch {
    return false;
  }
}
