import { expect, test } from 'bun:test';
import { buildRuleset } from './egress-ruleset';
import type { FirewallSlot, RulesetInput } from './egress-ruleset';

function buildSlot(slot: number, mode: FirewallSlot['mode']): FirewallSlot {
  return {
    slot,
    tap: `imp${String(slot)}`,
    guestIp: `10.66.0.${String(slot * 4 + 2)}`,
    guestIp6: null,
    mode,
    cidrs: [],
    addresses: [],
  };
}

function buildInput(change: Partial<RulesetInput>): RulesetInput {
  return {
    slots: [buildSlot(0, 'open'), buildSlot(1, 'box'), buildSlot(2, 'none')],
    networks: [],
    subnet: '10.66.0.0/16',
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: ['10.0.0.0/8', '172.17.0.0/16'],
    public6: ['fc00::/7', '2001:db8::/32'],
    uplinks4: ['eth0'],
    uplinks6: ['eth0'],
    dnsPort: 5353,
    setSize: 4096,
    ...change,
  };
}

function readChain(script: string, name: string): string[] {
  const lines = script.split('\n');
  const start = lines.indexOf(`  chain ${name} {`);

  return lines.slice(start + 1, lines.indexOf('  }', start)).map((line) => line.trim());
}

test('a network is a set of tap and address pairs, checked at both ends', () => {
  const script = buildRuleset(
    buildInput({
      networks: [
        [
          { tap: 'imp0', guestIp: '10.66.0.2' },
          { tap: 'imp1', guestIp: '10.66.0.6' },
        ],
      ],
    }),
  );

  expect(script).toContain('    type ifname . ipv4_addr\n');
  expect(script).toContain('elements = { "imp0" . 10.66.0.2, "imp1" . 10.66.0.6 }');

  expect(readChain(script, 'forward')).toEqual([
    'type filter hook forward priority filter - 1; policy accept;',
    'iifname != "imp*" accept',
    'iifname . ip saddr @net0 oifname . ip daddr @net0 meta mark set meta mark | 0x01000000 accept',
    'oifname "imp*" goto deny',
    'iifname vmap @slots',
    'goto deny',
  ]);
});

test('without networks, imp to imp traffic is refused before any policy', () => {
  const script = buildRuleset(buildInput({}));
  const forward = readChain(script, 'forward');

  expect(forward).not.toContain(expect.stringContaining('@net'));

  expect(forward.indexOf('oifname "imp*" goto deny')).toBeLessThan(
    forward.indexOf('iifname vmap @slots'),
  );
});

test('a query to an imp is not redirected, and an open peer redirects only IMP_DNS', () => {
  const script = buildRuleset(buildInput({ networks: [[{ tap: 'imp0', guestIp: '10.66.0.2' }]] }));

  expect(readChain(script, 'dns')).toEqual([
    'type nat hook prerouting priority dstnat - 1; policy accept;',
    'iifname @dns_taps meta nfproto ipv4 ip daddr != 10.66.0.0/16 meta l4proto { tcp, udp } th dport 53 redirect to :5353',
    'iifname @open_peer_taps ip daddr { 1.1.1.1, 8.8.8.8 } meta l4proto { tcp, udp } th dport 53 redirect to :5353',
  ]);

  // the open imp on the network, and not the box one
  expect(script).toMatch(/set open_peer_taps \{\n {4}type ifname\n {4}elements = \{ "imp0" \}/v);
});

test('a public slot leaves only by an uplink, then is refused its ranges in each family', () => {
  const script = buildRuleset(buildInput({ slots: [buildSlot(3, 'public')] }));

  expect(readChain(script, 'slot3')).toEqual([
    'ip saddr != 10.66.0.14 drop',
    'meta nfproto ipv6 drop',
    'ct state invalid drop',
    'meta nfproto ipv4 oifname != @uplinks4 goto deny',
    'meta nfproto ipv6 oifname != @uplinks6 goto deny',
    'ip daddr @public4 goto deny',
    'ip6 daddr @public6 goto deny',
    'accept',
  ]);

  expect(script).toContain(
    '  set public4 {\n    type ipv4_addr\n    flags interval\n    auto-merge\n    elements = { 10.0.0.0/8, 172.17.0.0/16 }\n  }',
  );

  expect(script).toContain(
    '  set public6 {\n    type ipv6_addr\n    flags interval\n    auto-merge\n    elements = { fc00::/7, 2001:db8::/32 }\n  }',
  );

  expect(script).toContain('  set uplinks4 {\n    type ifname\n    elements = { "eth0" }\n  }');
  expect(script).toContain('  set uplinks6 {\n    type ifname\n    elements = { "eth0" }\n  }');

  // its DNS goes to impd, whatever server it asks
  expect(script).toMatch(/set dns_taps \{\n {4}type ifname\n {4}elements = \{ "imp3" \}/v);
});

test('with no uplink, a public slot is refused everything', () => {
  const script = buildRuleset(
    buildInput({ slots: [buildSlot(3, 'public')], uplinks4: [], uplinks6: [] }),
  );

  // an empty set: `oifname != @uplinks4` matches every packet
  expect(script).toContain('  set uplinks4 {\n    type ifname\n  }');
  expect(readChain(script, 'slot3')).toContain('meta nfproto ipv4 oifname != @uplinks4 goto deny');
});

test('without a public slot, the table has no public sets', () => {
  const script = buildRuleset(buildInput({}));

  expect(script).not.toContain('public4');
  expect(script).not.toContain('uplinks');
});
