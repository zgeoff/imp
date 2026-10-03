import { existsSync } from 'node:fs';
import { runChecked } from '../process/run-command';
import { formatCidr4 } from './addressing';

// The host container's IPv4 networks and default-route interfaces, for the
// public egress chain; read at each table build, as a Docker network or
// tailscaled can add a route after impd starts. A failed read throws.

// route types that carry no traffic to a host on the link
const NON_UNICAST = new Set([
  'local',
  'broadcast',
  'blackhole',
  'unreachable',
  'prohibit',
  'throw',
  'multicast',
  'anycast',
  'nat',
]);

export async function readConnectedPrefixes4(): Promise<readonly string[]> {
  const routes = await runChecked(['ip', '-4', 'route', 'show']);
  const addresses = await runChecked(['ip', '-4', '-o', 'addr', 'show']);

  return parseConnectedPrefixes4(routes, addresses);
}

// On-link routes of any origin, and every address off the taps, with its
// prefix and as a /32, which no narrower route can uncover; canonical, with
// no repeats.
export function parseConnectedPrefixes4(routes: string, addresses: string): readonly string[] {
  const found = [
    ...routes.split('\n').flatMap((line) => {
      const words = line.trim().split(/\s+/v);
      const destination = (NON_UNICAST.has(words[0] ?? '') ? '' : words[0]) ?? '';
      const dev = /\bdev (?<dev>\S+)/v.exec(line)?.groups?.['dev'] ?? '';

      return line.includes(' via ') || dev.startsWith('imp') ? [] : [destination];
    }),
    ...addresses.split('\n').flatMap((line) => {
      const groups = /^\d+:\s+(?<dev>\S+)\s+inet\s+(?<cidr>\S+)/v.exec(line)?.groups ?? {};
      const dev = groups['dev'] ?? 'imp';
      const cidr = groups['cidr'] ?? '';

      return dev.startsWith('imp') || cidr === '' ? [] : [cidr, `${cidr.split('/')[0] ?? ''}/32`];
    }),
  ];

  const prefixes = new Set<string>();

  for (const text of found) {
    const prefix = formatCidr4(text);

    if (prefix !== null) {
      prefixes.add(prefix);
    }
  }

  return [...prefixes];
}

// The interfaces of the default routes, by family: the only ones a public
// imp's traffic may leave by. A kernel without IPv6 has none for it.
export interface Uplinks {
  readonly ipv4: readonly string[];
  readonly ipv6: readonly string[];
}

export async function readUplinks(procNet = '/proc/sys/net/ipv6'): Promise<Uplinks> {
  const ipv4 = await runChecked(['ip', '-4', 'route', 'show', 'default']);

  const ipv6 = existsSync(procNet)
    ? await runChecked(['ip', '-6', 'route', 'show', 'default'])
    : '';

  return { ipv4: parseUplinks(ipv4), ipv6: parseUplinks(ipv6) };
}

export function parseUplinks(routes: string): readonly string[] {
  const devs = routes.split('\n').flatMap((line) => {
    const dev = /\bdev (?<dev>\S+)/v.exec(line)?.groups?.['dev'];

    return line.startsWith('default') && dev !== undefined && !dev.startsWith('imp') ? [dev] : [];
  });

  return [...new Set(devs)];
}

// The interface the host container would send to `address` by, as `ip
// route get` reads every rule and table; the broker dials from the same
// namespace, so this is the route its tunnel takes.
export async function readRouteDevice(address: string): Promise<string> {
  const route = await runChecked(['ip', 'route', 'get', address]);

  return parseRouteDevice(route, address);
}

export function parseRouteDevice(route: string, address: string): string {
  const dev = /\bdev (?<dev>\S+)/v.exec(route)?.groups?.['dev'];

  if (dev === undefined) {
    throw new Error(`ip route get ${address} named no interface: ${route.trim()}`);
  }

  return dev;
}
