import * as z from 'zod';
import { runImpWith } from './imp-cli';
import type { ImpRunOptions } from './imp-cli';
import { runCommand } from './instance';
import { waitFor } from './wait-for';

const PeerSchema = z.object({
  DNSName: z.string().default(''),
  TailscaleIPs: z.array(z.string()).default([]),
  Online: z.boolean().default(false),
  Tags: z.array(z.string()).default([]),
});

const TailscaleStatusSchema = z.object({
  BackendState: z.string(),
  Peer: z.record(z.string(), PeerSchema).default({}),
});

export type TailscaleStatus = z.infer<typeof TailscaleStatusSchema>;

const SelfSchema = z.object({ Tags: z.array(z.string()).default([]) });
const SelfTagsSchema = z.object({ Self: SelfSchema });

// the tags a node joined with, from its own `tailscale status --json`
export function parseSelfTags(stdout: string): string[] {
  const json: unknown = JSON.parse(stdout);

  return SelfTagsSchema.parse(json).Self.Tags;
}

// a peer as `tailscale status --json` lists it
export interface TailnetPeer {
  readonly DNSName: string;
  readonly TailscaleIPs: readonly string[];
  readonly Online: boolean;
  readonly Tags?: readonly string[];
}

export interface TailnetNode {
  // MagicDNS name without the trailing dot
  readonly fqdn: string;

  // its first label, which MagicDNS also answers
  readonly short: string;

  // the tags the node joined with
  readonly tags: readonly string[];
}

const TAILNET_NOT_READY =
  'tailscale needs the tag:imp-e2e OAuth client (op://imp-e2e/imp-e2e-tailscale-oauth) and this machine on the tailnet';

// a tailnet suite runs only with the tag:imp-e2e key for impd's node and this
// machine on the tailnet to reach it from; `status` is this machine's
// `tailscale status`, null when it has none
export function isTailnetReady(
  status: Readonly<Pick<TailscaleStatus, 'BackendState'>> | null,
  hasKey: boolean,
): boolean {
  return hasKey && status?.BackendState === 'Running';
}

// fails a tailnet suite that must run, such as under acceptance, with what
// it lacks
export function requireTailnetReady(
  status: Readonly<Pick<TailscaleStatus, 'BackendState'>> | null,
  hasKey: boolean,
): void {
  if (!isTailnetReady(status, hasKey)) {
    throw new Error(TAILNET_NOT_READY);
  }
}

// `tailscale status --json`, or null when it is not that
export function parseTailscaleStatus(stdout: string): TailscaleStatus | null {
  let json: unknown;

  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }

  const status = TailscaleStatusSchema.safeParse(json);

  return status.success ? status.data : null;
}

// The online peer that holds `ip`, by IP and not by name: an offline node
// from an earlier run can still hold the name, and then this node is imp-1.
export function findTailnetNode(peers: readonly TailnetPeer[], ip: string): TailnetNode | null {
  const peer = peers.find((candidate) => candidate.Online && candidate.TailscaleIPs.includes(ip));

  if (peer === undefined || peer.DNSName === '') {
    return null;
  }

  const fqdn = peer.DNSName.replace(/\.$/v, '');
  const [short = ''] = fqdn.split('.');

  return { fqdn, short, tags: peer.Tags ?? [] };
}

// this machine's tailscale status, or null without the CLI or its JSON
export async function readLocalTailscaleStatus(): Promise<TailscaleStatus | null> {
  const result = await runCommand(['tailscale', 'status', '--json']).catch(() => null);

  return result === null ? null : parseTailscaleStatus(result.stdout);
}

const InfoTailscaleSchema = z.object({
  tailscale: z.object({ state: z.string().nullable(), ip: z.string().nullable() }),
});

// impd's tailnet IP once its node is Running, as after a reboot; the run's
// instance unless `options` names another
export async function waitForTailnetIp(options: Readonly<ImpRunOptions> = {}): Promise<string> {
  const ip = await waitFor(
    'impd tailscale state Running',
    async () => {
      const stdout = await runImpWith(options, 'info', '--json');

      const info = InfoTailscaleSchema.parse(JSON.parse(stdout));

      if (info.tailscale.state !== 'Running' || info.tailscale.ip === null) {
        throw new Error(`impd tailscale state ${String(info.tailscale.state)}`);
      }

      return info.tailscale.ip;
    },
    { timeoutMs: 120_000 },
  );

  return ip;
}

// the per-imp tailnet name among `imp url`'s lines, or null
export function findServiceUrl(stdout: string): string | null {
  return (
    stdout.split('\n').find((line) => /^https:\/\/[\w\-]+\.[\w\-]+\.ts\.net$/v.test(line)) ?? null
  );
}

// a call to impd's API over the tailnet, with no token
export function sendTailnetRpc(ip: string, path: string, input: unknown): Promise<Response> {
  return fetch(`http://${ip}:7070/rpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(30_000),
  });
}

// the trimmed body of a 2xx answer over the tailnet; any other status throws
export async function readTailnetBody(url: string, host?: string): Promise<string> {
  const response = await fetch(url, {
    ...(host !== undefined && { headers: { host } }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${url} answered ${String(response.status)}: ${body}`);
  }

  return body.trim();
}
