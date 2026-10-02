import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePrefix64 } from './addressing6';
import {
  parseConnectedRoutes,
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

function buildDeps(uplink: string | null, log: (line: string) => void): Ipv6PlanDeps {
  return { readDefaultRoute: () => Promise.resolve(uplink), readUlaPrefix: () => ULA, log };
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

  const without = await resolveIpv6Plan({ kind: 'auto' }, buildDeps(null, writeLine));
  const withRoute = await resolveIpv6Plan({ kind: 'auto' }, buildDeps('eth0', writeLine));

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
    buildDeps('eth0', () => {}),
  );

  expect(plan).toMatchObject({ nat66: false, uplink: 'eth0' });
  expect(plan?.prefix.text).toBe('2001:db8:c::/64');
});

test('the connected prefixes are the global and ULA routes off the taps', () => {
  const text = [
    '2001:db8:a::/64 dev eth0 proto kernel metric 256 pref medium',
    'fd00:1::/64 dev eth1 proto kernel metric 256 pref medium',
    'fd12:3456:789a::a42:2 dev imp0 metric 1024 pref medium',
    'fe80::/64 dev eth0 proto kernel metric 256 pref medium',
    'default via 2001:db8:a::1 dev eth0 metric 1024 pref medium',
  ].join('\n');

  expect(parseConnectedRoutes(text)).toEqual(['2001:db8:a::/64', 'fd00:1::/64']);
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
