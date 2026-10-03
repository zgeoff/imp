import { BlockList } from 'node:net';
import { parseIpv6 } from './addressing6';

// What no open, public or box imp reaches over IPv6, and no broker tunnel
// dials; docs/architecture/networking.md#blocked-ranges says why, and
// special-ranges.test.ts checks them against the IANA registry.
export const BLOCKED_RANGES6: readonly string[] = [
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '::/128',
  '::1/128',
  '::/96',
  '::ffff:0:0/96',
  '::ffff:0:0:0/96',
  '100::/64',
  '100:0:0:1::/64',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '2002::/16',
  '2001::/32',
  '2001:2::/48',
  '2001:10::/28',
  '5f00::/16',
];

// The documentation ranges, refused to public imps only: test networks use
// them, as the ipv6 e2e suite's open and box imps do.
export const DOCUMENTATION_RANGES6: readonly string[] = ['2001:db8::/32', '3fff::/20'];

// A checker for IPv6 CIDRs; anything that is not an IPv6 address counts as
// blocked.
export function createRangeChecker6(ranges: readonly string[]): (address: string) => boolean {
  const list = new BlockList();

  for (const range of ranges) {
    const [network = '', prefix = '128'] = range.split('/');

    list.addSubnet(network, Number(prefix), 'ipv6');
  }

  return (address) => parseIpv6(address) === null || list.check(address, 'ipv6');
}

// The IPv4 address an IPv4-mapped one (`::ffff:a.b.c.d`) holds, or null.
export function readMappedIpv4(address: string): string | null {
  const parsed = parseIpv6(address);

  if (parsed === null || parsed >> 32n !== 0xff_ffn) {
    return null;
  }

  const mapped = Number(parsed & 0xff_ff_ff_ffn);

  return [24, 16, 8, 0].map((shift) => String(Math.floor(mapped / 2 ** shift) % 256)).join('.');
}
