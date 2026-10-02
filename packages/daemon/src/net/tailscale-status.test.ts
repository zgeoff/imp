import { expect, test } from 'bun:test';
import { parseTailscaleStatus } from './tailscale-status';

test('it reads state, the MagicDNS name and the IPv4 address', () => {
  // an offline node still holds `imp`, so this one got `imp-1`
  const json = JSON.stringify({
    BackendState: 'Running',
    Self: {
      HostName: 'imp',
      DNSName: 'imp-1.tail1234.ts.net.',
      TailscaleIPs: ['fd7a:115c::1', '100.64.0.7'],
    },
  });

  expect(parseTailscaleStatus(json)).toEqual({
    state: 'Running',
    hostname: 'imp-1',
    dnsName: 'imp-1.tail1234.ts.net',
    ip: '100.64.0.7',
  });
});

test('it falls back to the hostname before MagicDNS names the node', () => {
  const json = JSON.stringify({
    BackendState: 'Starting',
    Self: { HostName: 'imp', DNSName: '', TailscaleIPs: [] },
  });

  expect(parseTailscaleStatus(json)).toEqual({
    state: 'Starting',
    hostname: 'imp',
    dnsName: null,
    ip: null,
  });
});

test('it gives nulls for output it cannot read', () => {
  expect(parseTailscaleStatus('')).toEqual({
    state: null,
    hostname: null,
    dnsName: null,
    ip: null,
  });
});
