import { NetworkEnvSchema } from './config';
import { formatSubnet, parseSubnet } from './net/addressing';

// `impd --network-env`: the settings that the host container's network setup reads, as impd
// resolves them with its defaults, for the entrypoint to export before setup-net.sh runs
export function renderNetworkEnv(env: Readonly<Record<string, string | undefined>>): string {
  // an empty variable means unset, as loadConfig reads it
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = NetworkEnvSchema.parse(present);

  return [
    `IMP_SUBNET=${formatSubnet(parseSubnet(parsed.IMP_SUBNET))}`,
    `IMP_BROKER_PORT=${String(parsed.IMP_BROKER_PORT)}`,
    `IMP_EGRESS_DNS_PORT=${String(parsed.IMP_EGRESS_DNS_PORT)}`,
    '',
  ].join('\n');
}
