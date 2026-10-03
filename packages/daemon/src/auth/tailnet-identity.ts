import { ImpPatternSchema, ScopeSchema } from '@imp/api';
import * as z from 'zod';
import type { TailscaleStatus } from '../net/tailscale-status';
import { runCommand } from '../process/run-command';
import type { Caller } from './caller';

// Tailnet identity (docs/guides/tokens.md#tailnet-identity): a connection
// from a tailnet address is asked about with `tailscale whois`, and the
// first rule that matches the peer gives it a scope. No rule, no access.

const TailnetRuleSchema = z
  .object({
    // `user:<login>`, `tag:<tag>`, or `*` for any peer
    match: z.string().regex(/^(?:user:\S+|tag:[\w-]+|\*)$/, 'must be user:<login>, tag:<tag> or *'),
    scope: ScopeSchema,
    imps: z.array(ImpPatternSchema).min(1).readonly().optional(),
  })
  .readonly();

export type TailnetRule = z.infer<typeof TailnetRuleSchema>;

export const TailnetRulesSchema = z.array(TailnetRuleSchema).min(1).readonly();

// who `tailscale whois` says is behind an address
export interface TailnetPeer {
  // the user's login; null for a tagged node, which has no user
  readonly login: string | null;
  readonly tags: readonly string[];

  // the node's MagicDNS name, without the tailnet
  readonly node: string;

  // the node's stable ID, which outlives a rename; null from a tailscale
  // whose whois leaves it out or sends it empty
  readonly stableId: string | null;
}

const TagsSchema = z.array(z.string()).nullable().optional();

const WhoisSchema = z.object({
  Node: z.object({ Name: z.string(), Tags: TagsSchema, StableID: z.string().optional() }),
  UserProfile: z.object({ LoginName: z.string() }),
});

// how long an answer counts, either way, and how many are kept
const WHOIS_TTL_MS = 60_000;
const MAX_CACHED = 256;

export interface TailnetIdentities {
  // the caller behind a tailnet peer address, or null
  readonly resolve: (address: string) => Promise<Caller | null>;
}

interface TailnetIdentitiesDeps {
  readonly rules: readonly TailnetRule[];
  readonly whois: (address: string) => Promise<TailnetPeer | null>;

  // the node's status, read at most every 30 s (createStatusCache)
  readonly readTailscale: () => Promise<TailscaleStatus>;
  readonly now: () => number;
}

export function createTailnetIdentities(deps: Readonly<TailnetIdentitiesDeps>): TailnetIdentities {
  const cache = new Map<
    string,
    { readonly peer: Promise<TailnetPeer | null>; readonly at: number }
  >();

  const readCachedPeer = (address: string): Promise<TailnetPeer | null> => {
    const at = deps.now();
    const cached = cache.get(address);

    if (cached !== undefined && at - cached.at < WHOIS_TTL_MS) {
      return cached.peer;
    }

    cache.delete(address);

    // a Map iterates in insertion order: the first key is the oldest
    while (cache.size >= MAX_CACHED) {
      const [oldest] = cache.keys();

      if (oldest === undefined) {
        break;
      }

      cache.delete(oldest);
    }

    const peer = readWhois(deps.whois, address);

    cache.set(address, { peer, at });

    return peer;
  };

  return {
    resolve: async (address) => {
      if (!isTailnetAddress(address)) {
        return null;
      }

      const plain = normalizeAddress(address);

      // impd itself, or an imp's traffic leaving through the node: the raw
      // rule lets local sources pass, and whois names the node's own tags
      const own = await isOwnAddress(deps.readTailscale, plain);

      if (own) {
        return null;
      }

      const peer = await readCachedPeer(plain);

      return peer === null ? null : findTailnetCaller(deps.rules, peer);
    },
  };
}

// The first rule that matches the peer, as a caller. A tagged node matches
// by its tags only: its whois user is the placeholder `tagged-devices`.
export function findTailnetCaller(
  rules: readonly TailnetRule[],
  peer: Readonly<TailnetPeer>,
): Caller | null {
  const rule = rules.find((each) => isRuleMatch(each.match, peer));

  if (rule === undefined) {
    return null;
  }

  return {
    kind: 'tailnet',
    name: peer.login ?? peer.node,
    scope: rule.scope,
    imps: rule.imps ?? null,
    grantable: [],
    tokenId: null,
    expiresAt: null,
    principal: readTailnetPrincipal(peer),
    display: peer.node,
  };
}

// A user owns leases across all of its nodes. A tagged node has no user, so
// it owns them by its stable ID; without one it owns none, since a later
// node can take its name.
function readTailnetPrincipal(peer: Readonly<TailnetPeer>): string | null {
  if (peer.login !== null) {
    return `tailnet-user:${peer.login}`;
  }

  return peer.stableId === null ? null : `tailnet:${peer.stableId}`;
}

// `tailscale whois --json <address>`; null when the address is no peer's
export function parseWhois(json: string): TailnetPeer | null {
  try {
    const whois = WhoisSchema.parse(JSON.parse(json));
    const tags = whois.Node.Tags ?? [];

    return {
      login: tags.length > 0 ? null : whois.UserProfile.LoginName,
      tags,
      node: whois.Node.Name.split('.')[0] ?? whois.Node.Name,
      stableId:
        whois.Node.StableID === undefined || whois.Node.StableID === ''
          ? null
          : whois.Node.StableID,
    };
  } catch {
    return null;
  }
}

export async function runWhois(address: string): Promise<TailnetPeer | null> {
  const result = await runCommand(['tailscale', 'whois', '--json', address]);

  return result.exitCode === 0 ? parseWhois(result.stdout) : null;
}

// a whois that fails, such as with tailscaled down, names nobody
async function readWhois(
  whois: TailnetIdentitiesDeps['whois'],
  address: string,
): Promise<TailnetPeer | null> {
  try {
    return await whois(address);
  } catch {
    return null;
  }
}

async function isOwnAddress(
  readTailscale: TailnetIdentitiesDeps['readTailscale'],
  address: string,
): Promise<boolean> {
  const status = await readTailscale();

  const wanted = address.toLowerCase();

  return status.ips.some((ip) => ip.toLowerCase() === wanted);
}

// Tailscale's ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. tailscaled
// drops packets from them that do not come in on tailscale0, and so does
// setup-net.sh, so the source address is the peer's.
export function isTailnetAddress(address: string): boolean {
  const plain = normalizeAddress(address);
  const octets = plain.split('.');

  if (octets.length === 4) {
    return octets[0] === '100' && Number(octets[1]) >= 64 && Number(octets[1]) <= 127;
  }

  return /^fd7a:115c:a1e0:/i.test(plain);
}

// Bun reports an IPv4 peer of a dual-stack socket as ::ffff:a.b.c.d
function normalizeAddress(address: string): string {
  return address.replace(/^::ffff:/i, '');
}

function isRuleMatch(match: string, peer: Readonly<TailnetPeer>): boolean {
  if (match === '*') {
    return true;
  }

  if (match.startsWith('tag:')) {
    return peer.tags.includes(match);
  }

  return peer.login !== null && match === `user:${peer.login}`;
}
