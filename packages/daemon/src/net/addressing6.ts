// IPv6 for imps (docs/architecture/networking.md#ipv6): one /64 per host,
// and one /128 per imp in it. The interface ID is the imp's IPv4 address, so
// a packet capture reads the same imp in both families.

const GROUPS = 8;
const GROUP_BITS = 16n;
const PREFIX_LENGTH = 64;

// every imp's gateway: the same link-local address on every tap
export const GATEWAY_IP6 = 'fe80::1';

export interface Prefix64 {
  readonly network: bigint;

  // the prefix as impd writes it: `fd12:3456:789a::/64`
  readonly text: string;
}

// A textual IPv6 address as a number, or null for anything else. An
// embedded IPv4 tail (`::ffff:1.2.3.4`) is read too.
export function parseIpv6(text: string): bigint | null {
  if (!text.includes(':') || text.includes('%') || text.includes('[')) {
    return null;
  }

  let normal: string;

  try {
    normal = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }

  const [head = '', tail] = normal.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = GROUPS - headGroups.length - tailGroups.length;

  if (tail === undefined ? missing !== 0 : missing < 1) {
    return null;
  }

  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];

  return groups.reduce((acc, group) => (acc << GROUP_BITS) + BigInt(`0x${group}`), 0n);
}

export function formatIpv6(address: bigint): string {
  const groups = Array.from({ length: GROUPS }, (_, index) =>
    ((address >> (GROUP_BITS * BigInt(GROUPS - 1 - index))) & 0xff_ffn).toString(16),
  );

  // the URL parser writes the canonical form (RFC 5952)
  return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1);
}

// IMP_SUBNET6 as a routed /64, or null when it is not one
export function parsePrefix64(cidr: string): Prefix64 | null {
  const [address = '', prefixText, ...rest] = cidr.split('/');
  const network = parseIpv6(address);

  if (network === null || rest.length > 0 || prefixText !== String(PREFIX_LENGTH)) {
    return null;
  }

  if (network % 2n ** 64n !== 0n) {
    return null;
  }

  return { network, text: `${formatIpv6(network)}/${String(PREFIX_LENGTH)}` };
}

// A unique local /64 (RFC 4193): fd, a random 40-bit global ID, subnet 0.
export function buildUlaPrefix(random: Uint8Array): Prefix64 {
  if (random.length < 5) {
    throw new Error('a ULA global ID needs 5 random bytes');
  }

  const globalId = [...random.subarray(0, 5)].reduce((acc, byte) => (acc << 8n) + BigInt(byte), 0n);
  const network = ((0xfdn << 40n) + globalId) << 80n;

  return { network, text: `${formatIpv6(network)}/${String(PREFIX_LENGTH)}` };
}

// An imp's /128: the prefix, then its IPv4 address as the interface ID.
export function deriveGuestIp6(prefix: Readonly<Prefix64>, guestIpv4: number): string {
  return formatIpv6(prefix.network + BigInt(guestIpv4));
}

// whether an address is in the /64
export function isInPrefix(prefix: Readonly<Prefix64>, address: string): boolean {
  const parsed = parseIpv6(address);

  return parsed !== null && parsed >> 64n === prefix.network >> 64n;
}
