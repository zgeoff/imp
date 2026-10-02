import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { parseIpv4 } from '../net/addressing';
import { formatIpv6, parseIpv6 } from '../net/addressing6';
import { readMappedIpv4 } from '../net/ranges6';

// Where a plain tunnel may go. It starts in the host container, past the
// `INPUT -i imp+ DROP` rule: unchecked, a guest could reach impd's API, the
// wake proxy and other imps' ports.

// [network, prefix length]: loopback, private, shared (the tailnet's 100.x),
// link-local, documentation, benchmark, multicast and the reserved top; the
// egress firewall refuses them to a box imp too
export const REFUSED_RANGES: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const PARSED_RANGES = REFUSED_RANGES.map(([network, prefix]) => {
  const parsed = parseIpv4(network);

  if (parsed === null) {
    throw new Error(`bad range ${network}`);
  }

  return { network: parsed, size: 2 ** (32 - prefix) };
});

export class TunnelRefusedError extends Error {
  override name = 'TunnelRefusedError';
}

// True for every address a tunnel must not reach: the ranges above, the
// host's own addresses, and the IPv6 `isBlocked6` blocks (all of it without
// one). A mapped address is checked as the IPv4 address it holds.
export function isRefusedAddress(
  address: string,
  hostAddresses: ReadonlySet<string>,
  isBlocked6: ((address: string) => boolean) | null = null,
): boolean {
  const hostKeys = new Set([...hostAddresses].map((host) => formatAddressKey(host)));

  const mapped = readMappedIpv4(address);

  if (hostKeys.has(formatAddressKey(mapped ?? address))) {
    return true;
  }

  const ip = parseIpv4(mapped ?? address);

  if (ip === null) {
    return isBlocked6 === null || parseIpv6(address) === null || isBlocked6(address);
  }

  return PARSED_RANGES.some((range) => ip >= range.network && ip < range.network + range.size);
}

// one spelling per address, so a match turns on neither case nor zeros
function formatAddressKey(address: string): string {
  const ip4 = parseIpv4(address);
  const ip6 = parseIpv6(address);

  if (ip4 !== null) {
    return String(ip4);
  }

  return ip6 === null ? address.toLowerCase() : formatIpv6(ip6);
}

// every address on the host's interfaces, read at call time: tailscaled can
// add one after impd starts
function readHostAddresses(): ReadonlySet<string> {
  const addresses = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((entry) => entry.address);

  return new Set(addresses);
}

export interface TunnelTargetDeps {
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly readHostAddresses?: () => ReadonlySet<string>;

  // with IPv6, which IPv6 addresses no tunnel reaches; without it, every
  // IPv6 address is refused and names resolve to IPv4 only
  readonly isBlocked6?: ((address: string) => boolean) | null;
}

// The address to dial for `host`, resolved once and dialled as checked, so a
// DNS rebind cannot swap it. Every answer must pass; IPv4 goes first, and a
// mapped answer is dialled as the IPv4 address it holds.
export async function resolveTunnelTarget(
  host: string,
  deps: TunnelTargetDeps = {},
): Promise<string> {
  const isBlocked6 = deps.isBlocked6 ?? null;
  const resolve = deps.resolve ?? ((name: string) => resolveAddresses(name, isBlocked6 !== null));
  const hostAddresses = (deps.readHostAddresses ?? readHostAddresses)();

  const answers = await resolve(host);

  const addresses = answers.map((address) => readMappedIpv4(address) ?? address);

  const [first] = [
    ...addresses.filter((address) => parseIpv4(address) !== null),
    ...addresses.filter((address) => parseIpv4(address) === null),
  ];

  if (first === undefined) {
    throw new TunnelRefusedError(`${host} has no address a tunnel may dial`);
  }

  const refused = addresses.find((address) => isRefusedAddress(address, hostAddresses, isBlocked6));

  if (refused !== undefined) {
    throw new TunnelRefusedError(`${host} resolves to ${refused}, which a tunnel may not reach`);
  }

  return first;
}

async function resolveAddresses(host: string, ipv6: boolean): Promise<readonly string[]> {
  // a literal is its own answer, and the check refuses what it must
  if (parseIpv4(host) !== null || host.includes(':')) {
    return [host];
  }

  const answers = await lookup(host, { all: true, family: ipv6 ? 0 : 4 });

  return answers.map((answer) => answer.address);
}
