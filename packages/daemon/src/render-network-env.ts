import type { Config } from './config';
import { formatSubnet } from './net/addressing';

// `impd --network-env`: the settings that the host container's network setup reads, as impd
// resolves them with its defaults, for the entrypoint to export before setup-net.sh runs
export function renderNetworkEnv(config: Config): string {
  return [
    `IMP_SUBNET=${formatSubnet(config.subnet)}`,
    `IMP_BROKER_PORT=${String(config.brokerPort)}`,
    `IMP_EGRESS_DNS_PORT=${String(config.egressDnsPort)}`,
    '',
  ].join('\n');
}
