import { BlockList } from 'node:net';
import { parseIpv6 } from './addressing6';

// What no imp reaches over IPv6, under `open` and `box`, and what a broker
// tunnel never dials; docs/architecture/networking.md#ipv6 says why each
// range is here.
export const BLOCKED_RANGES6: readonly string[] = [
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '2002::/16',
  '2001::/32',
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
