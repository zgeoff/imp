import * as z from 'zod';
import { runCommand } from '../process/run-command';

export interface TailscaleStatus {
  // tailscaled's BackendState: `Running` once the node is up
  readonly state: string | null;

  // the node's MagicDNS name, which members resolve: the configured hostname,
  // or `imp-1` and so on while an older node still holds that name
  readonly hostname: string | null;
  readonly ip: string | null;
}

const IpListSchema = z.array(z.string()).nullable().optional();

const StatusSchema = z.object({
  BackendState: z.string(),
  Self: z
    .object({ HostName: z.string(), DNSName: z.string().optional(), TailscaleIPs: IpListSchema })
    .optional(),
});

const UNKNOWN: TailscaleStatus = { state: null, hostname: null, ip: null };

// `tailscale status --json` in the host container; all null when no node is
// configured or tailscaled does not answer
export function parseTailscaleStatus(json: string): TailscaleStatus {
  try {
    const status = StatusSchema.parse(JSON.parse(json));
    const ips = status.Self?.TailscaleIPs ?? [];
    const dnsLabel = status.Self?.DNSName?.split('.')[0] ?? '';

    return {
      state: status.BackendState,
      hostname: dnsLabel === '' ? (status.Self?.HostName ?? null) : dnsLabel,
      ip: ips.find((ip) => ip.includes('.')) ?? ips[0] ?? null,
    };
  } catch {
    return UNKNOWN;
  }
}

export async function readTailscaleStatus(configured: boolean): Promise<TailscaleStatus> {
  if (!configured) {
    return UNKNOWN;
  }

  try {
    const result = await runCommand(['tailscale', 'status', '--json']);

    return parseTailscaleStatus(result.stdout);
  } catch {
    return UNKNOWN;
  }
}
