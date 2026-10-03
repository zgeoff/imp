import { runCommand } from '../process/run-command';
import { formatCidr4 } from './addressing';

// The host container's IPv4 networks and default-route interfaces, for the
// public egress chain; read at each table build, as a Docker network or
// tailscaled can add a route after impd starts.

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
  const routes = await runCommand(['ip', '-4', 'route', 'show']);
  const addresses = await runCommand(['ip', '-4', '-o', 'addr', 'show']);

  const routeText = routes.exitCode === 0 ? routes.stdout : '';
  const addressText = addresses.exitCode === 0 ? addresses.stdout : '';

  return parseConnectedPrefixes4(routeText, addressText);
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

// The interfaces of the IPv4 and IPv6 default routes: the only ones a
// `public` imp's traffic may leave by.
export async function readUplinks(): Promise<readonly string[]> {
  const ipv4 = await runCommand(['ip', '-4', 'route', 'show', 'default']);
  const ipv6 = await runCommand(['ip', '-6', 'route', 'show', 'default']);

  return parseUplinks(
    [ipv4, ipv6]
      .filter((result) => result.exitCode === 0)
      .map((result) => result.stdout)
      .join('\n'),
  );
}

export function parseUplinks(routes: string): readonly string[] {
  const devs = routes.split('\n').flatMap((line) => {
    const dev = /\bdev (?<dev>\S+)/v.exec(line)?.groups?.['dev'];

    return line.startsWith('default') && dev !== undefined && !dev.startsWith('imp') ? [dev] : [];
  });

  return [...new Set(devs)];
}
