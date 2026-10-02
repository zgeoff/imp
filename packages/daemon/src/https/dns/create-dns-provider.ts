import type { DnsConfig } from '../https-config';
import { createChalltestsrvProvider } from './challtestsrv-provider';
import { createCloudflareProvider } from './cloudflare-provider';
import type { DnsProvider } from './dns-provider';

// loadConfig has checked that each provider has what it needs
export function createDnsProvider(config: DnsConfig, log: (message: string) => void): DnsProvider {
  if (config.provider === 'challtestsrv') {
    return createChalltestsrvProvider(config.apiUrl ?? '');
  }

  return createCloudflareProvider({
    token: config.apiToken ?? '',
    log,
    ...(config.apiUrl !== null && { apiUrl: config.apiUrl }),
  });
}
