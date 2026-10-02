import type { EgressPolicy } from '@imp/api';
import { parseIpv4 } from '../net/addressing';

// An allow-list split by kind: exact names, wildcard suffixes and IPv4
// ranges, the ranges as [first, size].
export interface AllowRules {
  readonly names: ReadonlySet<string>;
  readonly suffixes: readonly string[];
  readonly ranges: readonly (readonly [number, number])[];
  readonly cidrs: readonly string[];
}

export function buildAllowRules(allow: readonly string[]): AllowRules {
  const names = new Set<string>();

  const suffixes: string[] = [];
  const ranges: (readonly [number, number])[] = [];
  const cidrs: string[] = [];

  for (const entry of allow) {
    const range = parseCidr(entry);

    if (range !== null) {
      ranges.push([range.first, range.size]);
      cidrs.push(range.text);
    } else if (entry.startsWith('*.')) {
      suffixes.push(entry.slice(1));
    } else {
      names.add(entry);
    }
  }

  return { names, suffixes, ranges, cidrs };
}

// a name as DNS and CONNECT give it: any case, maybe a trailing dot
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

// `*.example.com` covers every name under example.com, not example.com
export function isNameAllowed(rules: AllowRules, name: string): boolean {
  const normal = normalizeName(name);

  return rules.names.has(normal) || rules.suffixes.some((suffix) => normal.endsWith(suffix));
}

export function isAddressAllowed(rules: AllowRules, address: string): boolean {
  const ip = parseIpv4(address);

  return ip !== null && rules.ranges.some(([first, size]) => ip >= first && ip < first + size);
}

// What the broker's plain tunnel may reach, by the host the CONNECT names:
// a box allows its names, and an IPv4 literal its ranges allow.
export function isTunnelAllowed(policy: EgressPolicy, host: string): boolean {
  if (policy.mode !== 'box') {
    return policy.mode === 'open';
  }

  const rules = buildAllowRules(policy.allow);

  return isNameAllowed(rules, host) || isAddressAllowed(rules, host);
}

// the exact names of a list, which impd can resolve ahead of the guest
export function listExactNames(allow: readonly string[]): readonly string[] {
  return [...buildAllowRules(allow).names];
}

function parseCidr(
  entry: string,
): { readonly first: number; readonly size: number; readonly text: string } | null {
  const [address = '', prefixText] = entry.split('/');
  const first = parseIpv4(address);

  if (first === null) {
    return null;
  }

  const prefix = prefixText === undefined ? 32 : Number(prefixText);

  return { first, size: 2 ** (32 - prefix), text: `${address}/${String(prefix)}` };
}
