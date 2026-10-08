import { expect, test } from 'bun:test';
import { BLOCKED_RANGES6, createRangeChecker6 } from '../net/ranges6';
import {
  TunnelRefusedError,
  isRefusedAddress,
  requireUplinkRoute,
  resolveTunnelTarget,
} from './tunnel-target';

test.each([
  ['loopback', '127.0.0.1'],
  ['this network', '0.0.0.0'],
  ['private 10/8', '10.66.0.1'],
  ['private 172.16/12', '172.17.0.1'],
  ['private 192.168/16', '192.168.1.1'],
  ['link-local and cloud metadata', '169.254.169.254'],
  ['shared 100.64/10 (tailnet)', '100.101.102.103'],
  ['multicast', '239.1.2.3'],
  ['reserved', '250.0.0.1'],
  ['broadcast', '255.255.255.255'],
  ['documentation', '198.51.100.9'],
  ['benchmarking', '198.18.0.1'],
  ['a host address', '203.0.114.7'],
  ['ipv6 without an IPv6 plan', '2606:4700::1111'],
  ['ipv6 loopback', '::1'],
  ['v4-mapped loopback', '::ffff:127.0.0.1'],
  ['v4-mapped metadata', '::ffff:169.254.169.254'],
])('it refuses %s (%s) to a tunnel', (_what, address) => {
  expect(isRefusedAddress(address, new Set(['203.0.114.7', '10.66.0.1']))).toBeTrue();
});

test.each([
  ['140.82.112.3'],
  ['::ffff:140.82.112.3'],
  ['1.1.1.1'],
  ['100.63.255.255'],
  ['100.128.0.0'],
  ['172.32.0.1'],
])('it lets public IPv4 %s through', (address) => {
  expect(isRefusedAddress(address, new Set(['203.0.114.7', '10.66.0.1']))).toBeFalse();
});

test.each([
  ['2606:4700::1111', false],
  ['fd12:3456:789a::a42:6', true],
  ['fd00:ec2::254', true],
  ['64:ff9b::a9fe:a9fe', true],
  ['2001:db8:a::2', true],
] as const)('it holds IPv6 %s refused: %p, with an IPv6 plan', (address, refused) => {
  const isBlocked6 = createRangeChecker6([...BLOCKED_RANGES6, 'fd12:3456:789a::/64']);

  expect(
    isRefusedAddress(address, new Set(['203.0.114.7', '10.66.0.1', '2001:db8:a::2']), isBlocked6),
  ).toBe(refused);
});

test.each([
  ['2001:DB8:A::2'],
  ['2001:0db8:000a:0000:0000:0000:0000:0002'],
  ['::ffff:10.66.0.1'],
  ['010.066.000.001'],
])("it matches the host's own address spelt %s", (address) => {
  const isBlocked6 = createRangeChecker6(BLOCKED_RANGES6);

  expect(isRefusedAddress(address, new Set(['2001:db8:a::2', '10.66.0.1']), isBlocked6)).toBeTrue();
});

test("it lets through an IPv6 address next to the host's own", () => {
  const isBlocked6 = createRangeChecker6(BLOCKED_RANGES6);

  expect(
    isRefusedAddress('2001:db8:a::3', new Set(['2001:db8:a::2', '10.66.0.1']), isBlocked6),
  ).toBeFalse();
});

test('it dials the first address of a name whose answers all pass', async () => {
  const target = await resolveTunnelTarget('public.test', {
    resolve: () => Promise.resolve(['140.82.112.3', '140.82.112.4']),
    readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
  });

  expect(target).toBe('140.82.112.3');
});

test('it refuses a name with any inside answer', () => {
  expect(
    resolveTunnelTarget('rebind.test', {
      resolve: () => Promise.resolve(['140.82.112.3', '127.0.0.1']),
      readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
    }),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    'rebind.test resolves to 127.0.0.1, which a tunnel may not reach',
  );
});

test('it refuses a name with no answer', () => {
  expect(
    resolveTunnelTarget('none.test', {
      resolve: () => Promise.resolve([]),
      readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
    }),
  ).rejects.toThrowWithMessage(TunnelRefusedError, 'none.test has no address a tunnel may dial');
});

test.each([['127.0.0.1'], ['10.66.0.1'], ['::1'], ['203.0.114.7']])(
  'it refuses the IP literal %s without DNS',
  (host) => {
    expect(
      resolveTunnelTarget(host, { readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']) }),
    ).rejects.toThrowWithMessage(
      TunnelRefusedError,
      `${host} resolves to ${host}, which a tunnel may not reach`,
    );
  },
);

test('it dials a public IP literal as it is', async () => {
  const target = await resolveTunnelTarget('140.82.112.3', {
    readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
  });

  expect(target).toBe('140.82.112.3');
});

test('it refuses a name whose answer from the system resolver is loopback', () => {
  expect(
    resolveTunnelTarget('localhost', { readHostAddresses: () => new Set() }),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    'localhost resolves to 127.0.0.1, which a tunnel may not reach',
  );
});

// with every IPv6 address allowed, only the host's own interfaces, which
// hold ::1 on loopback, refuse it
test("it refuses the host's own interface address by default", () => {
  expect(resolveTunnelTarget('::1', { isBlocked6: () => false })).rejects.toThrowWithMessage(
    TunnelRefusedError,
    '::1 resolves to ::1, which a tunnel may not reach',
  );
});

test("it dials a public imp's name whose answers pass its own ranges", async () => {
  const target = await resolveTunnelTarget('public.test', {
    resolve: () => Promise.resolve(['140.82.112.3']),
    readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
    isRefusedMore: (address) => address === '8.8.4.4',
  });

  expect(target).toBe('140.82.112.3');
});

test.each([
  ['host.test', ['140.82.112.3', '8.8.4.4'], '8.8.4.4'],
  ['mapped.test', ['::ffff:8.8.4.4'], '8.8.4.4'],
  ['8.8.4.4', ['8.8.4.4'], '8.8.4.4'],
])(
  "it refuses a public imp's %s, whose answers hold one of its ranges",
  (host, answers, refused) => {
    expect(
      resolveTunnelTarget(host, {
        resolve: () => Promise.resolve(answers),
        readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
        isRefusedMore: (address) => address === '8.8.4.4',
      }),
    ).rejects.toThrowWithMessage(
      TunnelRefusedError,
      `${host} resolves to ${refused}, which a tunnel may not reach`,
    );
  },
);

test.each([
  ['dual.test', ['2606:4700::1111', '140.82.112.3'], '140.82.112.3'],
  ['six.test', ['2606:4700::1111'], '2606:4700::1111'],
  ['mapped.test', ['::ffff:140.82.112.3'], '140.82.112.3'],
])('it dials %s by IPv4 first, a mapped answer as its IPv4', async (host, answers, expected) => {
  const target = await resolveTunnelTarget(host, {
    resolve: () => Promise.resolve(answers),
    readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
    isBlocked6: createRangeChecker6([...BLOCKED_RANGES6, 'fd12:3456:789a::/64']),
  });

  expect(target).toBe(expected);
});

test.each([
  ['93.184.216.34', 'eth0'],
  ['2606:4700::1', 'eth1'],
])("it lets a public imp's tunnel to %s leave by uplink %s", (address, dev) => {
  expect(
    requireUplinkRoute('a.example', address, { ipv4: ['eth0'], ipv6: ['eth1'] }, () =>
      Promise.resolve(dev),
    ),
  ).resolves.toBeUndefined();
});

test("it refuses a public imp's IPv4 tunnel that leaves by another interface", () => {
  expect(
    requireUplinkRoute('b.example', '44.0.0.9', { ipv4: ['eth0'], ipv6: ['eth1'] }, () =>
      Promise.resolve('wg0'),
    ),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    'b.example resolves to 44.0.0.9, which the host reaches by wg0, not by a default route',
  );
});

test("it refuses a public imp's IPv6 tunnel that leaves by the IPv4 uplink", () => {
  expect(
    requireUplinkRoute('c.example', '2606:4700::2', { ipv4: ['eth0'], ipv6: ['eth1'] }, () =>
      Promise.resolve('eth0'),
    ),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    'c.example resolves to 2606:4700::2, which the host reaches by eth0, not by a default route',
  );
});

test("it refuses a public imp's tunnel whose route cannot be read", () => {
  expect(
    requireUplinkRoute('d.example', '203.0.113.9', { ipv4: ['eth0'], ipv6: ['eth1'] }, () =>
      Promise.reject(new Error('RTNETLINK answers: Network is unreachable')),
    ),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    'd.example: no route to 203.0.113.9: RTNETLINK answers: Network is unreachable',
  );
});
