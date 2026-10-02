import { expect, test } from 'bun:test';
import { TunnelRefusedError, isRefusedAddress, resolveTunnelTarget } from './tunnel-target';

const HOST_ADDRESSES = new Set(['203.0.114.7', '10.66.0.1']);

test('it refuses every address class a tunnel must not reach', () => {
  const refused = {
    loopback: '127.0.0.1',
    'this network': '0.0.0.0',
    'private 10/8': '10.66.0.1',
    'private 172.16/12': '172.17.0.1',
    'private 192.168/16': '192.168.1.1',
    'link-local and cloud metadata': '169.254.169.254',
    'shared 100.64/10 (tailnet)': '100.101.102.103',
    multicast: '239.1.2.3',
    reserved: '250.0.0.1',
    broadcast: '255.255.255.255',
    documentation: '198.51.100.9',
    benchmarking: '198.18.0.1',
    'a host address': '203.0.114.7',
    ipv6: '2606:4700::1111',
    'ipv6 loopback': '::1',
    'v4-mapped ipv6': '::ffff:127.0.0.1',
    'v4-mapped public': '::ffff:140.82.112.3',
  };

  for (const [what, address] of Object.entries(refused)) {
    expect({ what, refused: isRefusedAddress(address, HOST_ADDRESSES) }).toEqual({
      what,
      refused: true,
    });
  }
});

test('it lets public IPv4 through, the edges of the ranges included', () => {
  for (const address of [
    '140.82.112.3',
    '1.1.1.1',
    '100.63.255.255',
    '100.128.0.0',
    '172.32.0.1',
  ]) {
    expect({ address, refused: isRefusedAddress(address, HOST_ADDRESSES) }).toEqual({
      address,
      refused: false,
    });
  }
});

test('it dials the address it checked, and refuses a name with any inside answer', async () => {
  const answers: Record<string, readonly string[]> = {
    'public.test': ['140.82.112.3', '140.82.112.4'],
    'rebind.test': ['140.82.112.3', '127.0.0.1'],
    'none.test': [],
  };

  const deps = {
    resolve: (host: string) => Promise.resolve(answers[host] ?? []),
    readHostAddresses: () => HOST_ADDRESSES,
  };

  const target = await resolveTunnelTarget('public.test', deps);

  expect(target).toBe('140.82.112.3');

  for (const host of ['rebind.test', 'none.test']) {
    const failure = await resolveTunnelTarget(host, deps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TunnelRefusedError);
  }
});

test('IP literals and the host itself are checked without DNS', async () => {
  const deps = { readHostAddresses: () => HOST_ADDRESSES };

  for (const host of ['127.0.0.1', '10.66.0.1', '::1', '203.0.114.7']) {
    const failure = await resolveTunnelTarget(host, deps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TunnelRefusedError);
  }

  const literal = await resolveTunnelTarget('140.82.112.3', deps);

  expect(literal).toBe('140.82.112.3');
});
