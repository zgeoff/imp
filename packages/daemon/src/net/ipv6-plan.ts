import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runCommand } from '../process/run-command';
import { buildUlaPrefix, parsePrefix64 } from './addressing6';
import type { Prefix64 } from './addressing6';

// IMP_SUBNET6 (docs/architecture/networking.md#ipv6): `auto` is a unique
// local /64 behind NAT66, when the host container has an IPv6 route out;
// a routed /64 is used as it is; `off` gives imps no IPv6.
export type Ipv6Setting =
  | { readonly kind: 'auto' }
  | { readonly kind: 'off' }
  | { readonly kind: 'routed'; readonly prefix: Prefix64 };

// What this impd gives imps, decided once at start.
export interface Ipv6Plan {
  readonly prefix: Prefix64;

  // `auto`: the prefix is unique local, and impd masquerades it out of the
  // uplink, the interface of the container's IPv6 default route
  readonly nat66: boolean;
  readonly uplink: string | null;
}

export function parseIpv6Setting(text: string): Ipv6Setting {
  if (text === 'auto' || text === 'off') {
    return { kind: text };
  }

  const prefix = parsePrefix64(text);

  if (prefix === null) {
    throw new Error(`IMP_SUBNET6 must be auto, off or an IPv6 /64, got ${text}`);
  }

  return { kind: 'routed', prefix };
}

export interface Ipv6PlanDeps {
  // the interface of the container's IPv6 default route, or null
  readonly readDefaultRoute: () => Promise<string | null>;

  // the host's unique local prefix, made once and kept with its data
  readonly readUlaPrefix: () => Prefix64;
  readonly log: (message: string) => void;
}

// The plan, or null when imps get no IPv6, with a line in the log either way.
export async function resolveIpv6Plan(
  setting: Ipv6Setting,
  deps: Ipv6PlanDeps,
): Promise<Ipv6Plan | null> {
  if (setting.kind === 'off') {
    deps.log('impd: ipv6: off (IMP_SUBNET6=off)');

    return null;
  }

  const uplink = await deps.readDefaultRoute();

  if (setting.kind === 'routed') {
    deps.log(
      `impd: ipv6: ${setting.prefix.text}, routed${uplink === null ? '; the container has no IPv6 default route' : ` via ${uplink}`}`,
    );

    return { prefix: setting.prefix, nat66: false, uplink };
  }

  if (uplink === null) {
    deps.log('impd: ipv6: off (IMP_SUBNET6=auto, and the container has no IPv6 default route)');

    return null;
  }

  const prefix = deps.readUlaPrefix();

  deps.log(`impd: ipv6: ${prefix.text}, NAT66 out of ${uplink}`);

  return { prefix, nat66: true, uplink };
}

// `ip -6 route show default`: the device of the first default route
export async function readIpv6DefaultRoute(): Promise<string | null> {
  const result = await runCommand(['ip', '-6', 'route', 'show', 'default']);

  if (result.exitCode !== 0) {
    return null;
  }

  return /\bdev (?<dev>\S+)/.exec(result.stdout)?.groups?.['dev'] ?? null;
}

// The prefixes on the container's own links, which no imp may reach: a
// docker network's /64, say. Read at each table build, as interfaces come
// and go.
export async function readConnectedPrefixes6(): Promise<readonly string[]> {
  const result = await runCommand(['ip', '-6', 'route', 'show', 'proto', 'kernel']);

  if (result.exitCode !== 0) {
    return [];
  }

  return parseConnectedRoutes(result.stdout);
}

// global and unique local routes with no gateway, on interfaces that are
// not taps
export function parseConnectedRoutes(text: string): readonly string[] {
  const prefixes = new Set<string>();

  for (const line of text.split('\n')) {
    const [destination = ''] = line.split(' ');
    const dev = /\bdev (?<dev>\S+)/.exec(line)?.groups?.['dev'] ?? '';

    if (destination.includes(':') && !line.includes(' via ') && !dev.startsWith('imp')) {
      const isLocalOnly = destination.startsWith('fe80:') || destination.startsWith('ff');
      const prefix = destination.includes('/') ? destination : `${destination}/128`;

      if (!isLocalOnly) {
        prefixes.add(prefix);
      }
    }
  }

  return [...prefixes];
}

// <dataDir>/net/ipv6-ula: made on first need, so the prefix, and every
// imp's address in it, outlives restarts
export function readOrCreateUlaPrefix(path: string): Prefix64 {
  if (existsSync(path)) {
    const prefix = parsePrefix64(readFileSync(path, 'utf8').trim());

    if (prefix !== null) {
      return prefix;
    }
  }

  const prefix = buildUlaPrefix(randomBytes(5));

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${prefix.text}\n`);

  return prefix;
}
