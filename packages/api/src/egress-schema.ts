import * as z from 'zod';

const HOST_PATTERN = /^(?:[a-z0-9_][a-z0-9_-]{0,62}\.)+[a-z][a-z0-9-]{0,62}$/;
const CIDR_PATTERN = /^(?<address>(?:\d{1,3}\.){3}\d{1,3})(?:\/(?<prefix>\d{1,2}))?$/;

// What an imp may reach directly. `open` is anything but the metadata and
// tailnet ranges; `box` is the allow-list; `none` is nothing. Hosts a grant
// covers stay reachable through the credential broker under every mode.
export const EgressModeSchema = z.enum(['open', 'box', 'none']);

export type EgressMode = z.infer<typeof EgressModeSchema>;

// One allow entry: a lowercase hostname, `*.` and a hostname (its subdomains
// only), an IPv4 address or CIDR from /8, or a canonical IPv6 address or CIDR
// from /16. Only an address entry allows a private address.
export const EgressAllowEntrySchema = z
  .string()
  .max(253)
  .refine(
    (entry) => isHostEntry(entry) || isCidrEntry(entry) || isCidr6Entry(entry),
    'must be a lowercase hostname, *. and a hostname, an IPv4 address or CIDR from /8, or a canonical IPv6 address or CIDR from /16',
  );

export const EgressPolicySchema = z
  .object({
    mode: EgressModeSchema,
    allow: z.array(EgressAllowEntrySchema).max(256).readonly().default([]),
  })
  .refine((policy) => policy.mode === 'box' || policy.allow.length === 0, {
    message: 'only a box policy takes an allow-list',
    path: ['allow'],
  });

export type EgressPolicy = z.infer<typeof EgressPolicySchema>;

function isHostEntry(entry: string): boolean {
  const host = entry.startsWith('*.') ? entry.slice(2) : entry;

  return HOST_PATTERN.test(host);
}

function isCidrEntry(entry: string): boolean {
  const groups = CIDR_PATTERN.exec(entry)?.groups;

  if (groups === undefined) {
    return false;
  }

  const octets = (groups['address'] ?? '').split('.').map(Number);
  const prefix = Number(groups['prefix'] ?? '32');

  if (octets.some((octet) => octet > 255) || prefix < 8 || prefix > 32) {
    return false;
  }

  // no host bits past the prefix, as `ip route` would refuse
  const address = octets.reduce((acc, octet) => acc * 256 + octet, 0);

  return address % 2 ** (32 - prefix) === 0;
}

// an IPv6 address or CIDR as RFC 5952 writes it (lowercase, `::` for the
// longest zero run), so one range has one spelling
function isCidr6Entry(entry: string): boolean {
  const [address = '', prefixText = '128', ...rest] = entry.split('/');
  const prefix = Number(prefixText);

  if (rest.length > 0 || !/^\d{1,3}$/.test(prefixText) || prefix < 16 || prefix > 128) {
    return false;
  }

  if (!address.includes(':') || address.includes('.') || address.includes('%')) {
    return false;
  }

  let canonical: string;

  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return false;
  }

  if (canonical !== address) {
    return false;
  }

  // no host bits past the prefix
  const value = readIpv6Value(canonical);

  return value % 2n ** BigInt(128 - prefix) === 0n;
}

function readIpv6Value(canonical: string): bigint {
  const [head = '', tail] = canonical.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];

  return groups.reduce((acc, group) => (acc << 16n) + BigInt(`0x${group}`), 0n);
}
