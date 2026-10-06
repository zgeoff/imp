import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildNat66Removal, buildNat66Ruleset } from '../egress/egress-ruleset';
import { runChecked, runCommand } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import { buildUlaPrefix, formatCidr6, parsePrefix64 } from './addressing6';
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

  // what of setup-net's IPv6 rules is missing, or null when all are there
  readonly checkHostRules: () => Promise<string | null>;
  readonly runNft: (script: string) => Promise<void>;
  readonly log: (message: string) => void;
}

// The plan, or null when imps get no IPv6, logged either way. It fails
// closed: no setup-net rules, or no NAT66 when auto needs it, means no IPv6
// (docs/architecture/networking.md#ipv6).
export async function resolveIpv6Plan(
  setting: Ipv6Setting,
  deps: Ipv6PlanDeps,
): Promise<Ipv6Plan | null> {
  const stopIpv6 = async (reason: string): Promise<null> => {
    await removeNat66(deps);

    deps.log(`impd: ipv6: off (${reason})`);

    return null;
  };

  if (setting.kind === 'off') {
    return stopIpv6('IMP_SUBNET6=off');
  }

  const uplink = await deps.readDefaultRoute();

  if (setting.kind === 'auto' && uplink === null) {
    return stopIpv6('IMP_SUBNET6=auto, and the container has no IPv6 default route');
  }

  const missing = await deps.checkHostRules();

  if (missing !== null) {
    return stopIpv6(`the host's IPv6 rules are not in place: ${missing}`);
  }

  if (setting.kind === 'routed') {
    await removeNat66(deps);

    deps.log(
      `impd: ipv6: ${setting.prefix.text}, routed${uplink === null ? '; the container has no IPv6 default route' : ` via ${uplink}`}`,
    );

    return { prefix: setting.prefix, nat66: false, uplink };
  }

  const prefix = deps.readUlaPrefix();

  try {
    await deps.runNft(buildNat66Ruleset(prefix.text, uplink ?? ''));
  } catch (error) {
    return stopIpv6(`NAT66: ${readErrorMessage(error)}`);
  }

  deps.log(`impd: ipv6: ${prefix.text}, NAT66 out of ${uplink ?? ''}`);

  return { prefix, nat66: true, uplink };
}

// best effort: a host with no nftables has no table to remove
async function removeNat66(deps: Readonly<Pick<Ipv6PlanDeps, 'runNft'>>): Promise<void> {
  try {
    await deps.runNft(buildNat66Removal());
  } catch {
    // nothing to remove
  }
}

// What setup-net.sh puts in place for imps' IPv6
// (docs/architecture/networking.md#ipv6), by table.
const HOST_RULES6: readonly (readonly [string, string])[] = [
  ['filter', '-A INPUT -i imp+ -j DROP'],
  ['filter', '-A FORWARD -i imp+ -o imp+ -j DROP'],
  ['filter', '-A FORWARD -o imp+ -j DROP'],
  ['filter', '-A FORWARD -i imp+ -j DROP'],
  ['raw', '-A PREROUTING -i imp+ -m rpfilter --invert -j DROP'],
];

const HOST_SYSCTLS6: readonly (readonly [string, string])[] = [
  ['default/accept_ra', '0'],
  ['default/accept_redirects', '0'],
  ['all/forwarding', '1'],
];

// The first of setup-net's IPv6 rules and settings that is missing, or null.
export async function checkHostRules6(procSys = '/proc/sys/net/ipv6/conf'): Promise<string | null> {
  for (const table of ['filter', 'raw']) {
    const result = await runCommand(['ip6tables', '-w', '-t', table, '-S']);

    const rules = new Set(result.stdout.split('\n').map((line) => line.trim()));

    const missing = HOST_RULES6.find(([inTable, rule]) => inTable === table && !rules.has(rule));

    if (result.exitCode !== 0) {
      return `ip6tables -t ${table}: ${result.stderr.trim()}`;
    }

    if (missing !== undefined) {
      return `no ip6tables -t ${table} ${missing[1]}`;
    }
  }

  for (const [key, wanted] of HOST_SYSCTLS6) {
    const value = readSysctl(join(procSys, key));

    if (value !== wanted) {
      return `net.ipv6.conf.${key.replace('/', '.')} is ${value ?? 'missing'}, not ${wanted}`;
    }
  }

  return null;
}

function readSysctl(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

// `ip -6 route show default`: the device of the first default route
export async function readIpv6DefaultRoute(): Promise<string | null> {
  const result = await runCommand(['ip', '-6', 'route', 'show', 'default']);

  if (result.exitCode !== 0) {
    return null;
  }

  return /\bdev (?<dev>\S+)/.exec(result.stdout)?.groups?.['dev'] ?? null;
}

// The prefixes on the container's own links, which no imp may reach, read
// at each table build. A failed read throws: a blocklist without them would
// let an imp or a tunnel reach them.
export async function readConnectedPrefixes6(): Promise<readonly string[]> {
  const routes = await runChecked(['ip', '-6', 'route', 'show']);
  const addresses = await runChecked(['ip', '-6', '-o', 'addr', 'show']);

  return parseConnectedPrefixes(routes, addresses);
}

// On-link routes of any origin (kernel, ra, static), and the prefix of every
// global or unique local address, off the taps; canonical, with no repeats.
export function parseConnectedPrefixes(routes: string, addresses: string): readonly string[] {
  const found = [
    ...routes.split('\n').flatMap((line) => {
      const [destination = ''] = line.split(' ');
      const dev = /\bdev (?<dev>\S+)/.exec(line)?.groups?.['dev'] ?? '';

      return line.includes(' via ') || dev.startsWith('imp') ? [] : [destination];
    }),
    ...addresses.split('\n').flatMap((line) => {
      const match = /^\d+:\s+(?<dev>\S+)\s+inet6\s+(?<cidr>\S+)\s+scope\s+(?<scope>\S+)/.exec(line);
      const groups = match?.groups ?? {};
      const isGlobal = groups['scope'] === 'global' && !(groups['dev'] ?? 'imp').startsWith('imp');

      return isGlobal ? [groups['cidr'] ?? ''] : [];
    }),
  ];

  const prefixes = new Set<string>();

  for (const text of found) {
    const prefix = formatCidr6(text);
    const isLocalOnly = prefix === null || prefix.startsWith('fe80:') || prefix.startsWith('ff');

    if (prefix !== null && !isLocalOnly) {
      prefixes.add(prefix);
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
