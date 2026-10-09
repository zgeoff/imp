import { expect, mock, test } from 'bun:test';
import { buildStubTailscale } from '../test-utils/build-stub-tailscale';
import { createStatusCache, parseTailscaleStatus, readTailscaleStatus } from './tailscale-status';

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

  expect(parseTailscaleStatus(json)).toStrictEqual({
    state: 'Running',
    hostname: 'imp-1',
    dnsName: 'imp-1.tail1234.ts.net',
    ip: '100.64.0.7',
    ips: ['fd7a:115c::1', '100.64.0.7'],
  });
});

test('it takes the IPv6 address when the node has no IPv4 one', () => {
  const json = JSON.stringify({
    BackendState: 'Running',
    Self: { HostName: 'imp', DNSName: 'imp.tail1234.ts.net.', TailscaleIPs: ['fd7a:115c::1'] },
  });

  expect(parseTailscaleStatus(json).ip).toBe('fd7a:115c::1');
});

test('it falls back to the hostname before MagicDNS names the node', () => {
  const json = JSON.stringify({
    BackendState: 'Starting',
    Self: { HostName: 'imp', DNSName: '', TailscaleIPs: [] },
  });

  expect(parseTailscaleStatus(json)).toStrictEqual({
    state: 'Starting',
    hostname: 'imp',
    dnsName: null,
    ip: null,
    ips: [],
  });
});

test('it reads a node with no Self as a state and nothing else', () => {
  expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin' }))).toStrictEqual({
    state: 'NeedsLogin',
    hostname: null,
    dnsName: null,
    ip: null,
    ips: [],
  });
});

test('it gives nulls for output it cannot read', () => {
  expect(parseTailscaleStatus('')).toStrictEqual({
    state: null,
    hostname: null,
    dnsName: null,
    ip: null,
    ips: [],
  });
});

test('it reads the node from tailscale status when tailscale is configured', async () => {
  const tailscale = buildStubTailscale({
    status: {
      state: 'Running',
      hostname: 'imp',
      dnsName: 'imp.tail1234.ts.net',
      ip: '100.64.0.7',
      ips: ['100.64.0.7'],
    },
  });

  const status = await readTailscaleStatus(true, tailscale.run);

  expect(status).toStrictEqual({
    state: 'Running',
    hostname: 'imp',
    dnsName: 'imp.tail1234.ts.net',
    ip: '100.64.0.7',
    ips: ['100.64.0.7'],
  });
});

test('it gives nulls when tailscale is not configured', async () => {
  const status = await readTailscaleStatus(false, mock());

  expect(status).toStrictEqual({
    state: null,
    hostname: null,
    dnsName: null,
    ip: null,
    ips: [],
  });
});

test('it runs no tailscale command when tailscale is not configured', async () => {
  const run = mock();

  await readTailscaleStatus(false, run);

  expect(run).not.toHaveBeenCalled();
});

test('it gives nulls when tailscale cannot run', async () => {
  const status = await readTailscaleStatus(true, () =>
    Promise.reject(new Error('Executable not found in $PATH: "tailscale"')),
  );

  expect(status).toStrictEqual({
    state: null,
    hostname: null,
    dnsName: null,
    ip: null,
    ips: [],
  });
});

test('it reads tailscale again once 30 seconds have passed', async () => {
  const clock = { at: 0 };
  const reads = { count: 0 };

  const read = createStatusCache(
    () => {
      reads.count += 1;

      return Promise.resolve(parseTailscaleStatus(''));
    },
    () => clock.at,
  );

  await read();

  clock.at += 29_999;

  await read();

  const countBeforeExpiry = reads.count;

  clock.at += 1;

  await read();

  expect(countBeforeExpiry).toBe(1);
  expect(reads.count).toBe(2);
});
