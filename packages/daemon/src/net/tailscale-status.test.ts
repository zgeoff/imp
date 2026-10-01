import { expect, test } from 'bun:test';
import { parseTailscaleStatus } from './tailscale-status';

test('it reads state, hostname and the IPv4 address', () => {
  const json = JSON.stringify({
    BackendState: 'Running',
    Self: { HostName: 'imp', TailscaleIPs: ['fd7a:115c::1', '100.64.0.7'] },
  });

  expect(parseTailscaleStatus(json)).toEqual({
    state: 'Running',
    hostname: 'imp',
    ip: '100.64.0.7',
  });
});

test('it gives nulls for output it cannot read', () => {
  expect(parseTailscaleStatus('')).toEqual({ state: null, hostname: null, ip: null });
});
