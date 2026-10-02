import { expect, test } from 'bun:test';
import { createStatusCache, parseTailscaleStatus } from './tailscale-status';
import type { TailscaleStatus } from './tailscale-status';

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
    ips: ['fd7a:115c::1', '100.64.0.7'],
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
    ips: [],
  });
});

test('it gives nulls for output it cannot read', () => {
  expect(parseTailscaleStatus('')).toEqual({
    state: null,
    hostname: null,
    dnsName: null,
    ip: null,
    ips: [],
  });
});

test('the status cache reads tailscale at most every 30 seconds', async () => {
  const clock = { at: 0 };
  const reads = { count: 0 };

  const read = createStatusCache(
    () => {
      reads.count += 1;

      const status: TailscaleStatus = parseTailscaleStatus('');

      return Promise.resolve(status);
    },
    () => clock.at,
  );

  await read();

  clock.at += 29_999;

  await read();

  expect(reads.count).toBe(1);

  clock.at += 1;

  await read();

  expect(reads.count).toBe(2);
});
