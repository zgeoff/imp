import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { buildStubIpCommand } from '../test-utils/build-stub-ip-command';
import { parsePrefix64 } from './addressing6';
import {
  checkHostRules6,
  parseConnectedPrefixes,
  parseIpv6Setting,
  readConnectedPrefixes6,
  readIpv6DefaultRoute,
  readOrCreateUlaPrefix,
  resolveIpv6Plan,
} from './ipv6-plan';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-ipv6-plan-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test.each(['auto', 'off'] as const)('it reads IMP_SUBNET6=%s as that setting', (text) => {
  expect(parseIpv6Setting(text)).toStrictEqual({ kind: text });
});

test('it reads a /64 IMP_SUBNET6 as a routed prefix', () => {
  expect(parseIpv6Setting('2001:db8:c::/64')).toStrictEqual({
    kind: 'routed',
    prefix: { network: 0x20_01_0d_b8_00_0c_00_00n << 64n, text: '2001:db8:c::/64' },
  });
});

test('it rejects an IMP_SUBNET6 that is not auto, off or a /64', () => {
  expect(() => parseIpv6Setting('2001:db8:c::/56')).toThrowWithMessage(
    Error,
    'IMP_SUBNET6 must be auto, off or an IPv6 /64, got 2001:db8:c::/56',
  );
});

test('it gives auto a NAT66 unique local prefix out of the IPv6 default route', async () => {
  const ula = parsePrefix64('fd12:3456:789a::/64');

  invariant(ula);

  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => ula,
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
    log: mock(),
  };

  const plan = await resolveIpv6Plan({ kind: 'auto' }, deps);

  expect(plan).toStrictEqual({ prefix: ula, nat66: true, uplink: 'eth0' });

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
    [
      'table ip6 imp_nat66 {}',
      'delete table ip6 imp_nat66',
      'table ip6 imp_nat66 {',
      '  chain postrouting {',
      '    type nat hook postrouting priority srcnat; policy accept;',
      '    oifname "eth0" ip6 saddr fd12:3456:789a::/64 masquerade',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  expect(deps.log).toHaveBeenCalledExactlyOnceWith(
    'impd: ipv6: fd12:3456:789a::/64, NAT66 out of eth0',
  );
});

test('it turns auto off, and removes NAT66, without an IPv6 default route', async () => {
  const deps = {
    readDefaultRoute: () => Promise.resolve(null),
    readUlaPrefix: () => {
      throw new Error('auto with no route makes no prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
    log: mock(),
  };

  const plan = await resolveIpv6Plan({ kind: 'auto' }, deps);

  expect(plan).toBeNull();

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
    'table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n',
  );

  expect(deps.log).toHaveBeenCalledExactlyOnceWith(
    'impd: ipv6: off (IMP_SUBNET6=auto, and the container has no IPv6 default route)',
  );
});

test('it uses a routed /64 as it is, without NAT, via the IPv6 default route', async () => {
  const setting = parseIpv6Setting('2001:db8:c::/64');

  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => {
      throw new Error('a routed /64 makes no unique local prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
    log: mock(),
  };

  const plan = await resolveIpv6Plan(setting, deps);

  expect(plan).toStrictEqual({
    prefix: { network: 0x20_01_0d_b8_00_0c_00_00n << 64n, text: '2001:db8:c::/64' },
    nat66: false,
    uplink: 'eth0',
  });

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
    'table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n',
  );

  expect(deps.log).toHaveBeenCalledExactlyOnceWith('impd: ipv6: 2001:db8:c::/64, routed via eth0');
});

test('it uses a routed /64 with no IPv6 default route, and says so', async () => {
  const setting = parseIpv6Setting('2001:db8:c::/64');

  const deps = {
    readDefaultRoute: () => Promise.resolve(null),
    readUlaPrefix: () => {
      throw new Error('a routed /64 makes no unique local prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
    log: mock(),
  };

  const plan = await resolveIpv6Plan(setting, deps);

  expect(plan?.uplink).toBeNull();

  expect(deps.log).toHaveBeenCalledExactlyOnceWith(
    'impd: ipv6: 2001:db8:c::/64, routed; the container has no IPv6 default route',
  );
});

test('it turns IPv6 off, and removes NAT66, when the setting is off', async () => {
  const deps = {
    readDefaultRoute: mock(() => Promise.resolve('eth0')),
    readUlaPrefix: () => {
      throw new Error('off makes no prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.resolve()),
    log: mock(),
  };

  const plan = await resolveIpv6Plan({ kind: 'off' }, deps);

  expect(plan).toBeNull();
  expect(deps.readDefaultRoute).not.toHaveBeenCalled();

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
    'table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n',
  );

  expect(deps.log).toHaveBeenCalledExactlyOnceWith('impd: ipv6: off (IMP_SUBNET6=off)');
});

test('it turns IPv6 off when nft cannot remove a NAT66 table, as on a host without nftables', async () => {
  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => {
      throw new Error('off makes no prefix');
    },
    checkHostRules: () => Promise.resolve(null),
    runNft: mock(() => Promise.reject(new Error('nft: No such file or directory'))),
    log: mock(),
  };

  const plan = await resolveIpv6Plan({ kind: 'off' }, deps);

  expect(plan).toBeNull();
  expect(deps.runNft).toHaveBeenCalledOnce();
  expect(deps.log).toHaveBeenCalledExactlyOnceWith('impd: ipv6: off (IMP_SUBNET6=off)');
});

test('it turns IPv6 off, and removes NAT66, when the host lacks its IPv6 rules', async () => {
  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => {
      throw new Error('a host without its rules makes no prefix');
    },
    checkHostRules: () => Promise.resolve('no ip6tables -t filter -A INPUT -i imp+ -j DROP'),
    runNft: mock(() => Promise.resolve()),
    log: mock(),
  };

  const plan = await resolveIpv6Plan({ kind: 'auto' }, deps);

  expect(plan).toBeNull();

  expect(deps.runNft).toHaveBeenCalledExactlyOnceWith(
    'table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n',
  );

  expect(deps.log).toHaveBeenCalledExactlyOnceWith(
    "impd: ipv6: off (the host's IPv6 rules are not in place: no ip6tables -t filter -A INPUT -i imp+ -j DROP)",
  );
});

test('it turns IPv6 off when the NAT66 table cannot be written', async () => {
  const ula = parsePrefix64('fd12:3456:789a::/64');

  invariant(ula);

  const deps = {
    readDefaultRoute: () => Promise.resolve('eth0'),
    readUlaPrefix: () => ula,
    checkHostRules: () => Promise.resolve(null),
    runNft: mock<(script: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Operation not supported'))
      .mockResolvedValue(undefined),
    log: mock(),
  };

  const plan = await resolveIpv6Plan({ kind: 'auto' }, deps);

  expect(plan).toBeNull();

  expect(deps.runNft.mock.calls).toStrictEqual([
    [
      [
        'table ip6 imp_nat66 {}',
        'delete table ip6 imp_nat66',
        'table ip6 imp_nat66 {',
        '  chain postrouting {',
        '    type nat hook postrouting priority srcnat; policy accept;',
        '    oifname "eth0" ip6 saddr fd12:3456:789a::/64 masquerade',
        '  }',
        '}',
        '',
      ].join('\n'),
    ],
    ['table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n'],
  ]);

  expect(deps.log).toHaveBeenCalledExactlyOnceWith(
    'impd: ipv6: off (NAT66: Operation not supported)',
  );
});

test("it finds every one of setup-net's IPv6 rules and settings in place", async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': [
        '-P INPUT ACCEPT',
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
        '',
      ].join('\n'),
      'ip6tables -w -t raw -S': '-A PREROUTING -i imp+ -m rpfilter --invert -j DROP\n',
    },
  });

  await mkdir(join(ctx.dir, 'default'));
  await mkdir(join(ctx.dir, 'all'));
  await writeFile(join(ctx.dir, 'default', 'accept_ra'), '0\n');
  await writeFile(join(ctx.dir, 'default', 'accept_redirects'), '0\n');
  await writeFile(join(ctx.dir, 'all', 'forwarding'), '1\n');

  const missing = await checkHostRules6(ctx.dir, ip.run);

  expect(missing).toBeNull();
});

test('it names the first missing filter rule', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': '-A INPUT -i imp+ -j DROP\n-A FORWARD -o imp+ -j DROP\n',
    },
  });

  const missing = await checkHostRules6(ctx.dir, ip.run);

  expect(missing).toBe('no ip6tables -t filter -A FORWARD -i imp+ -o imp+ -j DROP');
});

test('it names the missing raw rule once the filter rules are in place', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': [
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
      ].join('\n'),

      // a raw table with only its default policies
      'ip6tables -w -t raw -S': '-P PREROUTING ACCEPT\n-P OUTPUT ACCEPT\n',
    },
  });

  const missing = await checkHostRules6(ctx.dir, ip.run);

  expect(missing).toBe('no ip6tables -t raw -A PREROUTING -i imp+ -m rpfilter --invert -j DROP');
});

test.each(['filter', 'raw'])('it reports an ip6tables -t %s that fails', async (table) => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': [
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
      ].join('\n'),
    },
    failures: {
      [`ip6tables -w -t ${table}`]: `ip6tables v1.8.10 (nf_tables): table '${table}' does not exist`,
    },
  });

  const missing = await checkHostRules6(ctx.dir, ip.run);

  expect(missing).toBe(
    `ip6tables -t ${table}: ip6tables v1.8.10 (nf_tables): table '${table}' does not exist`,
  );
});

test('it names an IPv6 sysctl the kernel does not have', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': [
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
      ].join('\n'),
      'ip6tables -w -t raw -S': '-A PREROUTING -i imp+ -m rpfilter --invert -j DROP\n',
    },
  });

  await mkdir(join(ctx.dir, 'default'));
  await mkdir(join(ctx.dir, 'all'));
  await writeFile(join(ctx.dir, 'default', 'accept_redirects'), '0\n');
  await writeFile(join(ctx.dir, 'all', 'forwarding'), '1\n');

  const missing = await checkHostRules6(ctx.dir, ip.run);

  expect(missing).toBe('net.ipv6.conf.default.accept_ra is missing, not 0');
});

test('it names an IPv6 sysctl that holds the wrong value', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip6tables -w -t filter -S': [
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
      ].join('\n'),
      'ip6tables -w -t raw -S': '-A PREROUTING -i imp+ -m rpfilter --invert -j DROP\n',
    },
  });

  await mkdir(join(ctx.dir, 'default'));
  await mkdir(join(ctx.dir, 'all'));
  await writeFile(join(ctx.dir, 'default', 'accept_redirects'), '0\n');
  await writeFile(join(ctx.dir, 'default', 'accept_ra'), '0\n');
  await writeFile(join(ctx.dir, 'all', 'forwarding'), '0\n');

  const missing = await checkHostRules6(ctx.dir, ip.run);

  expect(missing).toBe('net.ipv6.conf.all.forwarding is 0, not 1');
});

test('it reads the device of the first IPv6 default route', async () => {
  const ip = buildStubIpCommand({
    outputs: {
      'ip -6 route show default': [
        'default via fe80::1 dev eth1 metric 1024 pref medium',
        'default via fe80::2 dev eth2 metric 2048 pref medium',
        '',
      ].join('\n'),
    },
  });

  const dev = await readIpv6DefaultRoute(ip.run);

  expect(dev).toBe('eth1');
});

test('it reads no IPv6 default route when there is none', async () => {
  const ip = buildStubIpCommand({ outputs: { 'ip -6 route show default': '' } });

  const dev = await readIpv6DefaultRoute(ip.run);

  expect(dev).toBeNull();
});

test('it reads no IPv6 default route when ip fails', async () => {
  const ip = buildStubIpCommand({
    failures: { 'ip -6 route': 'RTNETLINK answers: Address family not supported by protocol' },
  });

  const dev = await readIpv6DefaultRoute(ip.run);

  expect(dev).toBeNull();
});

test('it reads the on-link routes and global addresses off the taps as connected prefixes', () => {
  const routes = [
    '2001:db8:a::/64 dev eth0 proto kernel metric 256 pref medium',
    '2001:DB8:0e::/64 dev eth1 proto ra metric 1024 expires 86000sec pref medium',
    'fd00:1::/64 dev eth1 proto kernel metric 256 pref medium',
    'fd12:3456:789a::a42:2 dev imp0 metric 1024 pref medium',
    'fe80::/64 dev eth0 proto kernel metric 256 pref medium',
    'default via 2001:db8:a::1 dev eth0 metric 1024 pref medium',
  ].join('\n');

  const addresses = [
    '1: lo    inet6 ::1/128 scope host noprefixroute',
    '2: eth0    inet6 2001:0db8:000a:0000::2/64 scope global',
    '3: eth2    inet6 2001:db8:f:0:1234::9/80 scope global dynamic mngtmpaddr',
    '4: imp0    inet6 fe80::1/64 scope link nodad',
    '2: eth0    inet6 fe80::42:acff:fe11:2/64 scope link',
  ].join('\n');

  expect(parseConnectedPrefixes(routes, addresses)).toStrictEqual([
    '2001:db8:a::/64',
    '2001:db8:e::/64',
    'fd00:1::/64',
    '2001:db8:f:0:1234::/80',
  ]);
});

test('it reads the connected IPv6 prefixes from the host routes and addresses', async () => {
  const ip = buildStubIpCommand({
    outputs: {
      'ip -6 route show': '2001:db8:a::/64 dev eth0 proto kernel metric 256 pref medium\n',
      'ip -6 -o addr show': '3: eth2    inet6 2001:db8:f::9/64 scope global\n',
    },
  });

  const prefixes = await readConnectedPrefixes6(ip.runChecked);

  expect(prefixes).toStrictEqual(['2001:db8:a::/64', '2001:db8:f::/64']);
});

test('it fails the connected IPv6 prefix read when ip fails', () => {
  const ip = buildStubIpCommand({ failures: { 'ip -6 route': 'Cannot open netlink socket' } });

  expect(readConnectedPrefixes6(ip.runChecked)).rejects.toThrowWithMessage(
    Error,
    'ip -6 route show exited 2: Cannot open netlink socket',
  );
});

test('it makes a unique local prefix on first need and writes it under the data dir', async () => {
  const ctx = await setupTest();

  const prefix = readOrCreateUlaPrefix(join(ctx.dir, 'net', 'ipv6-ula'));

  const written = await readFile(join(ctx.dir, 'net', 'ipv6-ula'), 'utf8');

  expect(parsePrefix64(prefix.text)).toStrictEqual(prefix);
  expect(prefix.text).toStartWith('fd');
  expect(written).toBe(`${prefix.text}\n`);
});

test('it keeps the unique local prefix it wrote before', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dir, 'net'));
  await writeFile(join(ctx.dir, 'net', 'ipv6-ula'), 'fd12:3456:789a::/64\n');

  expect(readOrCreateUlaPrefix(join(ctx.dir, 'net', 'ipv6-ula'))).toStrictEqual({
    network: 0xfd_12_34_56_78_9an << 80n,
    text: 'fd12:3456:789a::/64',
  });
});

test('it replaces a prefix file it cannot read with a new unique local prefix', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dir, 'net'));
  await writeFile(join(ctx.dir, 'net', 'ipv6-ula'), 'junk\n');

  const prefix = readOrCreateUlaPrefix(join(ctx.dir, 'net', 'ipv6-ula'));

  const written = await readFile(join(ctx.dir, 'net', 'ipv6-ula'), 'utf8');

  expect(prefix.text).toStartWith('fd');
  expect(written).toBe(`${prefix.text}\n`);
});
