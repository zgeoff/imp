import * as z from 'zod';
import { runCommand } from '../process/run-command';
import type { CommandResult } from '../process/run-command';

export interface TailscaleStatus {
  // tailscaled's BackendState: `Running` once the node is up
  readonly state: string | null;

  // the node's MagicDNS name, which members resolve: the configured hostname,
  // or `imp-1` and so on while an older node still holds that name
  readonly hostname: string | null;

  // the full MagicDNS name, without the trailing dot
  readonly dnsName: string | null;

  // the IPv4 address, else the IPv6 one; ips holds every one
  readonly ip: string | null;
  readonly ips: readonly string[];
}

const IpListSchema = z.array(z.string()).nullable().optional();

const StatusSchema = z.object({
  BackendState: z.string(),
  Self: z
    .object({ HostName: z.string(), DNSName: z.string().optional(), TailscaleIPs: IpListSchema })
    .optional(),
});

const UNKNOWN: TailscaleStatus = { state: null, hostname: null, dnsName: null, ip: null, ips: [] };

// how long a status read by createStatusCache counts
const STATUS_TTL_MS = 30_000;

// `tailscale status --json` in the host container; all null when no node is
// configured or tailscaled does not answer
export function parseTailscaleStatus(json: string): TailscaleStatus {
  try {
    const status = StatusSchema.parse(JSON.parse(json));
    const ips = status.Self?.TailscaleIPs ?? [];
    const dnsName = status.Self?.DNSName?.replace(/\.$/, '') ?? '';
    const dnsLabel = dnsName.split('.')[0] ?? '';

    return {
      state: status.BackendState,
      hostname: dnsLabel === '' ? (status.Self?.HostName ?? null) : dnsLabel,
      dnsName: dnsName === '' ? null : dnsName,
      ip: ips.find((ip) => ip.includes('.')) ?? ips[0] ?? null,
      ips,
    };
  } catch {
    return UNKNOWN;
  }
}

// The node's status, or all null when tailscale is off, fails or is missing.
// `run` runs the command, runCommand by default.
export async function readTailscaleStatus(
  configured: boolean,
  run: (argv: readonly string[]) => Promise<CommandResult> = runCommand,
): Promise<TailscaleStatus> {
  if (!configured) {
    return UNKNOWN;
  }

  try {
    const result = await run(['tailscale', 'status', '--json']);

    return parseTailscaleStatus(result.stdout);
  } catch {
    return UNKNOWN;
  }
}

// `tailscale status` at most every 30 s, for callers on every request
export function createStatusCache(
  read: () => Promise<TailscaleStatus>,
  now: () => number,
): () => Promise<TailscaleStatus> {
  const state: { status: Promise<TailscaleStatus> | null; at: number } = { status: null, at: 0 };

  return () => {
    const at = now();

    if (state.status === null || at - state.at >= STATUS_TTL_MS) {
      state.status = read();
      state.at = at;
    }

    return state.status;
  };
}
