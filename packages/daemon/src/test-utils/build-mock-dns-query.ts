import { faker } from '@faker-js/faker';
import { DNS_CLASS_IN, DNS_TYPE_CODES, writeDnsName, writeDnsUint16 } from './write-dns-wire';

// A query as a guest's resolver sends it, byte by byte from RFC 1035, with
// RFC 6891's EDNS OPT record unless left out.

const TYPE_OPT = 41;
const RD = 0x01_00;

interface MockDnsQuery {
  readonly name: string;
  readonly type: keyof typeof DNS_TYPE_CODES;
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
    ...writeDnsUint16(id),
    ...writeDnsUint16(RD),
    ...writeDnsUint16(1),
    ...writeDnsUint16(0),
    ...writeDnsUint16(0),
    ...writeDnsUint16(additionals),
    ...writeDnsName(query.name),
    ...writeDnsUint16(DNS_TYPE_CODES[query.type]),
    ...writeDnsUint16(DNS_CLASS_IN),
    ...(edns ? [0, ...writeDnsUint16(TYPE_OPT), ...writeDnsUint16(1232), 0, 0, 0, 0, 0, 0] : []),
  ]);
}
