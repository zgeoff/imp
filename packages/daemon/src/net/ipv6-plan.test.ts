import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePrefix64 } from './addressing6';
import {
  parseConnectedPrefixes,
  parseIpv6Setting,
  readOrCreateUlaPrefix,
  resolveIpv6Plan,
} from './ipv6-plan';
import type { Ipv6PlanDeps } from './ipv6-plan';

const ULA = requirePrefix('fd12:3456:789a::/64');

function requirePrefix(text: string) {
  const prefix = parsePrefix64(text);

  if (prefix === null) {
    throw new Error(`not a /64: ${text}`);
  }

  return prefix;
}

interface FakeHost {
  readonly uplink?: string | null;
  readonly missing?: string | null;
  readonly failNat66?: boolean;
}

// the scripts nft took, and the log
function buildDeps(
  host: Readonly<FakeHost>,
  log: (line: string) => void,
  writeScript: (script: string) => void = () => {},
) {
  const uplink = host.uplink === undefined ? 'eth0' : host.uplink;

  const deps: Ipv6PlanDeps = {
    readDefaultRoute: () => Promise.resolve(uplink),
    readUlaPrefix: () => ULA,
    checkHostRules: () => Promise.resolve(host.missing ?? null),
    runNft: (script) => {
      if (host.failNat66 === true && script.includes('masquerade')) {
        return Promise.reject(new Error('Operation not supported'));
      }

      writeScript(script);

      return Promise.resolve();
    },
    log,
  };

  return deps;
}

test('IMP_SUBNET6 is auto, off or a /64', () => {
  expect(parseIpv6Setting('auto')).toEqual({ kind: 'auto' });
  expect(parseIpv6Setting('off')).toEqual({ kind: 'off' });
  expect(parseIpv6Setting('2001:db8:c::/64')).toMatchObject({ kind: 'routed' });
  expect(() => parseIpv6Setting('2001:db8:c::/56')).toThrow('IMP_SUBNET6 must be');
});

test('auto is off without an IPv6 default route, and a NAT66 ULA with one', async () => {
  const lines: string[] = [];

  const writeLine = (line: string): void => {
    lines.push(line);
  };

  const without = await resolveIpv6Plan({ kind: 'auto' }, buildDeps({ uplink: null }, writeLine));
  const withRoute = await resolveIpv6Plan({ kind: 'auto' }, buildDeps({}, writeLine));

  expect(without).toBeNull();
  expect(withRoute).toEqual({ prefix: ULA, nat66: true, uplink: 'eth0' });

  expect(lines).toEqual([
    'impd: ipv6: off (IMP_SUBNET6=auto, and the container has no IPv6 default route)',
    'impd: ipv6: fd12:3456:789a::/64, NAT66 out of eth0',
  ]);
});

test('a routed /64 is used as it is, without NAT', async () => {
  const setting = parseIpv6Setting('2001:db8:c::/64');

  const plan = await resolveIpv6Plan(
    setting,
    buildDeps({}, () => {}),
  );

  expect(plan).toMatchObject({ nat66: false, uplink: 'eth0' });
  expect(plan?.prefix.text).toBe('2001:db8:c::/64');
});

test('IPv6 is off, and NAT66 gone, when the host lacks its IPv6 rules', async () => {
  const lines: string[] = [];
  const scripts: string[] = [];

  const writeLine = (line: string): void => {
    lines.push(line);
  };

  const missing = 'no ip6tables -t filter -A INPUT -i imp+ -j DROP';

  const plan = await resolveIpv6Plan(
    { kind: 'auto' },
    buildDeps({ missing }, writeLine, (script) => {
      scripts.push(script);
    }),
  );

  expect(plan).toBeNull();
  expect(lines).toEqual([`impd: ipv6: off (the host's IPv6 rules are not in place: ${missing})`]);
  expect(scripts).toEqual(['table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n']);
});

test('IPv6 is off when the NAT66 table cannot be written', async () => {
  const lines: string[] = [];

  const writeLine = (line: string): void => {
    lines.push(line);
  };

  const plan = await resolveIpv6Plan({ kind: 'auto' }, buildDeps({ failNat66: true }, writeLine));

  expect(plan).toBeNull();
  expect(lines).toEqual(['impd: ipv6: off (NAT66: Operation not supported)']);
});

test('off and a routed /64 remove the NAT66 table that auto made', async () => {
  const scripts: string[] = [];

  const deps = buildDeps(
    {},
    () => {},
    (script) => {
      scripts.push(script);
    },
  );

  await resolveIpv6Plan({ kind: 'auto' }, deps);
  await resolveIpv6Plan(parseIpv6Setting('2001:db8:c::/64'), deps);
  await resolveIpv6Plan({ kind: 'off' }, deps);

  expect(scripts.map((script) => script.includes('masquerade'))).toEqual([true, false, false]);

  expect(
    scripts.slice(1).every((script) => script.includes('delete table ip6 imp_nat66')),
  ).toBeTrue();
});

test('the connected prefixes are on-link routes and global addresses off the taps', () => {
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

  expect(parseConnectedPrefixes(routes, addresses)).toEqual([
    '2001:db8:a::/64',
    '2001:db8:e::/64',
    'fd00:1::/64',
    '2001:db8:f:0:1234::/80',
  ]);
});

test('the ULA prefix is made once and kept', () => {
  const dir = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'ula-'));

  try {
    const path = join(dir, 'net', 'ipv6-ula');
    const first = readOrCreateUlaPrefix(path);
    const again = readOrCreateUlaPrefix(path);

    expect(first.text).toStartWith('fd');
    expect(again).toEqual(first);
    expect(readFileSync(path, 'utf8')).toBe(`${first.text}\n`);

    writeFileSync(path, 'junk\n');

    expect(readOrCreateUlaPrefix(path).text).toStartWith('fd');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
