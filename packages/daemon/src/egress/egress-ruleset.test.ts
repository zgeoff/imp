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
