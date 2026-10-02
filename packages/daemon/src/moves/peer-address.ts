import { BlockList, isIP } from 'node:net';

// Tailscale's address ranges: CGNAT for IPv4, its ULA prefix for IPv6
const TAILNET_V4 = { address: '100.64.0.0', prefix: 10 } as const;
const TAILNET_V6 = { address: 'fd7a:115c:a1e0::', prefix: 48 } as const;

export interface PeerRanges {
  readonly isAllowed: (address: string) => boolean;

  // the extra range, for the start-up warning; null on the tailnet only
  readonly testCidr: string | null;
}

// The addresses a move may come from or go to: the tailnet, plus one test
// range that only an e2e host (IMP_E2E=1) may add, for dev instances on a
// Docker network with no tailnet.
export function createPeerRanges(testCidr: string | null): PeerRanges {
  const list = new BlockList();

  list.addSubnet(TAILNET_V4.address, TAILNET_V4.prefix, 'ipv4');
  list.addSubnet(TAILNET_V6.address, TAILNET_V6.prefix, 'ipv6');

  if (testCidr !== null) {
    const [address = '', prefix = ''] = testCidr.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';

    list.addSubnet(address, Number(prefix), family);
  }

  return {
    isAllowed: (address) => {
      // an IPv4 client on a dual-stack socket shows as ::ffff:a.b.c.d
      const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
      const family = isIP(plain);

      if (family === 0) {
        return false;
      }

      const kind = family === 6 ? 'ipv6' : 'ipv4';

      return list.check(plain, kind);
    },
    testCidr,
  };
}

// The literal address a peer URL names. A name is refused: a lookup could
// send the bytes off the tailnet.
export function readPeerUrlAddress(url: string): string | null {
  const host = new URL(url).hostname.replaceAll(/^\[|\]$/g, '');

  return isIP(host) === 0 ? null : host;
}
