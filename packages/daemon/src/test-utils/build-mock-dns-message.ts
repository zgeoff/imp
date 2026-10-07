import { faker } from '@faker-js/faker';

// DNS messages as a guest's resolver or an upstream server sends them, built
// byte by byte from RFC 1035 (and RFC 3596 for AAAA, RFC 6891 for the EDNS
// OPT record), with no name compression.

const TYPE_CODES = { A: 1, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28 } as const;

export type MockDnsType = keyof typeof TYPE_CODES;

const CLASS_IN = 1;
const TYPE_OPT = 41;
const QR = 0x80_00;
const TC = 0x02_00;
const RD = 0x01_00;
const RA = 0x00_80;

interface MockDnsQuery {
  readonly name: string;
  readonly type: MockDnsType;
  readonly id: number;

  // an OPT record with a 1232-byte payload size, as dig and systemd send
  readonly edns: boolean;
}

// A one-question query with recursion desired. The id is arbitrary.
export function buildMockDnsQuery(
  query: Readonly<Pick<MockDnsQuery, 'name' | 'type'> & Partial<MockDnsQuery>>,
): Uint8Array {
  const id = query.id ?? faker.number.int({ min: 0, max: 0xff_ff });
  const edns = query.edns ?? true;
  const additionals = edns ? 1 : 0;

  return Uint8Array.from([
    ...writeUint16(id),
    ...writeUint16(RD),
    ...writeUint16(1),
    ...writeUint16(0),
    ...writeUint16(0),
    ...writeUint16(additionals),
    ...writeName(query.name),
    ...writeUint16(TYPE_CODES[query.type]),
    ...writeUint16(CLASS_IN),
    ...(edns ? [0, ...writeUint16(TYPE_OPT), ...writeUint16(1232), 0, 0, 0, 0, 0, 0] : []),
  ]);
}

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
    ...writeUint16(id),
    ...writeUint16(flags),
    ...writeUint16(1),
    ...writeUint16(answers.length),
    ...writeUint16(authorities.length),
    ...writeUint16(additionals.length),
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
    ...writeName(record.name),
    ...writeUint16(TYPE_CODES[record.type]),
    ...writeUint16(CLASS_IN),
    ...writeUint16(Math.floor(record.ttl / 0x1_00_00)),
    ...writeUint16(record.ttl % 0x1_00_00),
    ...writeUint16(data.length),
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

  return writeName(record.data);
}

function writeIpv6(address: string): number[] {
  const [head = '', tail = ''] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const fill = Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => '0');
  const groups = address.includes('::') ? [...headGroups, ...fill, ...tailGroups] : headGroups;

  return groups.flatMap((group) => writeUint16(Number.parseInt(group, 16)));
}

function writeName(name: string): number[] {
  const labels = name.split('.').filter((label) => label !== '');
  const bytes: number[] = [];

  for (const label of labels) {
    bytes.push(label.length, ...new TextEncoder().encode(label));
  }

  bytes.push(0);

  return bytes;
}

function writeUint16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}
