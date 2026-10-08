import { DNS_CLASS_IN, DNS_TYPE_CODES, writeDnsName, writeDnsUint16 } from './write-dns-wire';

// An upstream's reply, byte by byte from RFC 1035 (RFC 3596 for AAAA), with
// no name compression.

const QR = 0x80_00;
const TC = 0x02_00;
const RD = 0x01_00;
const RA = 0x00_80;

export interface MockDnsRecord {
  readonly type: 'A' | 'AAAA' | 'CNAME';
  readonly name: string;
  readonly ttl: number;

  // an address, or for a CNAME the name it points at
  readonly data: string;
}

interface MockDnsReply {
  readonly answers: readonly MockDnsRecord[];
  readonly authorities: readonly MockDnsRecord[];
  readonly additionals: readonly MockDnsRecord[];

  // TC: the answer did not fit, so the client asks again over TCP
  readonly truncated: boolean;

  // the id the reply carries; the query's by default
  readonly id: number;
}

// An upstream's reply to `query`: its id and question, recursion available,
// NOERROR, and the records given in each section.
export function buildMockDnsReply(
  query: Uint8Array,
  reply: Readonly<Partial<MockDnsReply>> = {},
): Uint8Array {
  const answers = reply.answers ?? [];
  const authorities = reply.authorities ?? [];
  const additionals = reply.additionals ?? [];
  const id = reply.id ?? ((query[0] ?? 0) << 8) | (query[1] ?? 0);
  const flags = QR | RD | RA | (reply.truncated === true ? TC : 0);

  return Uint8Array.from([
    ...writeDnsUint16(id),
    ...writeDnsUint16(flags),
    ...writeDnsUint16(1),
    ...writeDnsUint16(answers.length),
    ...writeDnsUint16(authorities.length),
    ...writeDnsUint16(additionals.length),
    ...readQuestion(query),
    ...[...answers, ...authorities, ...additionals].flatMap((record) => writeRecord(record)),
  ]);
}

// the query's one question, as it came: the name's labels, type and class
function readQuestion(query: Uint8Array): number[] {
  let end = 12;

  while ((query[end] ?? 0) !== 0) {
    end += 1 + (query[end] ?? 0);
  }

  return [...query.subarray(12, end + 5)];
}

function writeRecord(record: MockDnsRecord): number[] {
  const data = writeRecordData(record);

  return [
    ...writeDnsName(record.name),
    ...writeDnsUint16(DNS_TYPE_CODES[record.type]),
    ...writeDnsUint16(DNS_CLASS_IN),
    ...writeDnsUint16(Math.floor(record.ttl / 0x1_00_00)),
    ...writeDnsUint16(record.ttl % 0x1_00_00),
    ...writeDnsUint16(data.length),
    ...data,
  ];
}

function writeRecordData(record: MockDnsRecord): number[] {
  if (record.type === 'A') {
    return record.data.split('.').map(Number);
  }

  if (record.type === 'AAAA') {
    return writeIpv6(record.data);
  }

  return writeDnsName(record.data);
}

function writeIpv6(address: string): number[] {
  const [head = '', tail = ''] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const fill = Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => '0');
  const groups = address.includes('::') ? [...headGroups, ...fill, ...tailGroups] : headGroups;

  return groups.flatMap((group) => writeDnsUint16(Number.parseInt(group, 16)));
}
