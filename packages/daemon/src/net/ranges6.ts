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

// The rest of 2001::/23, not globally reachable, refused to public imps
// only; docs/architecture/networking.md#blocked-ranges says which global
// blocks stay, and why 2001:1::/32 goes whole.
export const RESERVED_RANGES6: readonly string[] = [
  '2001::/31',
  '2001:2::/32',
  '2001:4::/40',
  '2001:4:100::/44',
  '2001:4:110::/47',
  '2001:4:113::/48',
  '2001:4:114::/46',
  '2001:4:118::/45',
  '2001:4:120::/43',
  '2001:4:140::/42',
  '2001:4:180::/41',
  '2001:4:200::/39',
  '2001:4:400::/38',
  '2001:4:800::/37',
  '2001:4:1000::/36',
  '2001:4:2000::/35',
  '2001:4:4000::/34',
  '2001:4:8000::/33',
  '2001:5::/32',
  '2001:6::/31',
  '2001:8::/29',
  '2001:10::/28',
  '2001:40::/26',
  '2001:80::/25',
  '2001:100::/24',
];

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
