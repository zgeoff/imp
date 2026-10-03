import { BlockList } from 'node:net';

// True for an address in one of the CIDRs of its family. A list per family:
// one BlockList matches IPv4 against ::ffff:0:0/96, so BLOCKED_RANGES6 would
// take every IPv4 address.
export function createRangeChecker(
  ranges4: readonly string[],
  ranges6: readonly string[],
): (address: string) => boolean {
  const lists = { ipv4: new BlockList(), ipv6: new BlockList() };

  for (const [ranges, family] of [
    [ranges4, 'ipv4'],
    [ranges6, 'ipv6'],
  ] as const) {
    for (const range of ranges) {
      const [network = '', prefix = family === 'ipv4' ? '32' : '128'] = range.split('/');

      lists[family].addSubnet(network, Number(prefix), family);
    }
  }

  return (address) => {
    const family = address.includes(':') ? 'ipv6' : 'ipv4';

    try {
      return lists[family].check(address, family);
    } catch {
      return false;
    }
  };
}
