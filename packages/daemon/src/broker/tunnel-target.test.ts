import { expect, test } from 'bun:test';
import { BLOCKED_RANGES6, createRangeChecker6 } from '../net/ranges6';
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
    'v4-mapped metadata': '::ffff:169.254.169.254',
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
    '::ffff:140.82.112.3',
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

test("a public imp's tunnel is refused its own ranges too, whichever answer holds one", async () => {
  const answers: Record<string, readonly string[]> = {
    'public.test': ['140.82.112.3'],
    'host.test': ['140.82.112.3', '8.8.4.4'],
    'mapped.test': ['::ffff:8.8.4.4'],
  };

  const deps = {
    resolve: (host: string) => Promise.resolve(answers[host] ?? []),
    readHostAddresses: () => HOST_ADDRESSES,
    isRefusedMore: (address: string) => address === '8.8.4.4',
  };

  const target = await resolveTunnelTarget('public.test', deps);

  expect(target).toBe('140.82.112.3');

  for (const host of ['host.test', 'mapped.test', '8.8.4.4']) {
    const failure = await resolveTunnelTarget(host, deps).catch((error: unknown) => error);

    expect({ host, refused: failure instanceof TunnelRefusedError }).toEqual({
      host,
      refused: true,
    });
  }
});

const isBlocked6 = createRangeChecker6([...BLOCKED_RANGES6, 'fd12:3456:789a::/64']);

test('with IPv6, a public IPv6 address passes and the blocked ranges and host do not', () => {
  const hosts = new Set([...HOST_ADDRESSES, '2001:db8:a::2']);

  for (const [address, refused] of [
    ['2606:4700::1111', false],
    ['fd12:3456:789a::a42:6', true],
    ['fd00:ec2::254', true],
    ['64:ff9b::a9fe:a9fe', true],
    ['2001:db8:a::2', true],
  ] as const) {
    expect({ address, refused: isRefusedAddress(address, hosts, isBlocked6) }).toEqual({
      address,
      refused,
    });
  }
});

test('a name dials IPv4 first, and a mapped answer as the IPv4 address it holds', async () => {
  const answers: Record<string, readonly string[]> = {
    'dual.test': ['2606:4700::1111', '140.82.112.3'],
    'six.test': ['2606:4700::1111'],
    'mapped.test': ['::ffff:140.82.112.3'],
  };

  const deps = {
    resolve: (host: string) => Promise.resolve(answers[host] ?? []),
    readHostAddresses: () => HOST_ADDRESSES,
    isBlocked6,
  };

  const dual = await resolveTunnelTarget('dual.test', deps);
  const six = await resolveTunnelTarget('six.test', deps);
  const mapped = await resolveTunnelTarget('mapped.test', deps);

  expect([dual, six, mapped]).toEqual(['140.82.112.3', '2606:4700::1111', '140.82.112.3']);
});

test("the host's own addresses match whatever their spelling", () => {
  const hosts = new Set(['2001:db8:a::2', '10.66.0.1']);

  const checkBlocked6 = createRangeChecker6(BLOCKED_RANGES6);

  const refused = [
    '2001:DB8:A::2',
    '2001:0db8:000a:0000:0000:0000:0000:0002',
    '::ffff:10.66.0.1',
    '010.066.000.001',
  ].map((address) => isRefusedAddress(address, hosts, checkBlocked6));

  expect(refused).toEqual([true, true, true, true]);
  expect(isRefusedAddress('2001:db8:a::3', hosts, checkBlocked6)).toBeFalse();
});
