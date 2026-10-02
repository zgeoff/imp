import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { parseIpv4 } from '../net/addressing';

// Where a plain tunnel may go. It starts in the host container, past the
// `INPUT -i imp+ DROP` rule: unchecked, a guest could reach impd's API, the
// wake proxy and other imps' ports.

// [network, prefix length]: loopback, private, shared (CGNAT, which holds
// the tailnet's 100.x), link-local, the documentation and benchmark ranges,
// multicast and the reserved top
const REFUSED_RANGES: readonly (readonly [string, number])[] = [
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

// True for every address a tunnel must not reach: anything not IPv4 (IPv6,
// v4-mapped IPv6 included), the ranges above, and the host's own addresses.
export function isRefusedAddress(address: string, hostAddresses: ReadonlySet<string>): boolean {
  const ip = parseIpv4(address);

  if (ip === null || hostAddresses.has(address)) {
    return true;
  }

  return PARSED_RANGES.some((range) => ip >= range.network && ip < range.network + range.size);
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
}

// The IPv4 address to dial for `host`: resolved once and dialled as
// checked, so a DNS rebind cannot swap it. Every answer must pass; a name
// that also points inside is refused outright.
export async function resolveTunnelTarget(
  host: string,
  deps: TunnelTargetDeps = {},
): Promise<string> {
  const resolve = deps.resolve ?? resolveIpv4;
  const hostAddresses = (deps.readHostAddresses ?? readHostAddresses)();

  const addresses = await resolve(host);

  const [first] = addresses;

  if (first === undefined) {
    throw new TunnelRefusedError(`${host} has no IPv4 address`);
  }

  const refused = addresses.find((address) => isRefusedAddress(address, hostAddresses));

  if (refused !== undefined) {
    throw new TunnelRefusedError(`${host} resolves to ${refused}, which a tunnel may not reach`);
  }

  return first;
}

async function resolveIpv4(host: string): Promise<readonly string[]> {
  // an IPv4 literal is its own answer; an IPv6 one is refused by the check
  if (parseIpv4(host) !== null || host.includes(':')) {
    return [host];
  }

  const answers = await lookup(host, { all: true, family: 4 });

  return answers.map((answer) => answer.address);
}
