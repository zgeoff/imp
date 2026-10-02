import { expect, test } from 'bun:test';
import { REFUSED_RANGES } from '../../packages/daemon/src/broker/tunnel-target';
import {
  buildElementChange,
  buildNat66Ruleset,
  buildRuleset,
} from '../../packages/daemon/src/egress/egress-ruleset';
import type { FirewallSlot } from '../../packages/daemon/src/egress/egress-ruleset';
import { BLOCKED_RANGES6 } from '../../packages/daemon/src/net/ranges6';

// impd's table, applied by the real nft in a fresh user and network
// namespace. Skipped where that is not allowed, or nft is missing.
const canUnshare =
  Bun.spawnSync(['unshare', '-rn', 'nft', 'list', 'ruleset'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const PRIVATE = [
  ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
  '10.66.0.0/16',
];

const SLOTS: readonly FirewallSlot[] = [
  {
    slot: 0,
    tap: 'imp0',
    guestIp: '10.66.0.2',
    guestIp6: 'fd12:3456:789a::a42:2',
    mode: 'open',
    cidrs: [],
    addresses: [],
  },
  {
    slot: 1,
    tap: 'imp1',
    guestIp: '10.66.0.6',
    guestIp6: 'fd12:3456:789a::a42:6',
    mode: 'box',
    cidrs: ['172.17.0.1/32', '2001:db8:c::/48'],
    addresses: ['140.82.112.3', '2001:db8:b::1'],
  },
  {
    slot: 2,
    tap: 'imp2',
    guestIp: '10.66.0.10',
    guestIp6: null,
    mode: 'none',
    cidrs: [],
    addresses: [],
  },
];

const BLOCKED6 = [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'];

const BASE = {
  networks: [],
  subnet: '10.66.0.0/16',
  dnsServers: ['1.1.1.1', '8.8.8.8'],
  privateRanges: PRIVATE,
  blocked6: BLOCKED6,
  dnsPort: 7053,
  setSize: 4096,
};

function runNft(scripts: Readonly<Record<string, string>>, after: string): string {
  const result = Bun.spawnSync(['unshare', '-rn', 'bash', '-euo', 'pipefail', '-c', after], {
    env: { ...process.env, ...scripts },
  });

  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);

  return result.stdout.toString();
}

test.skipIf(!canUnshare)('the table applies over itself, and takes element changes', () => {
  const first = buildRuleset({ ...BASE, slots: SLOTS });

  // slot 1 gone, as after an imp rm: its set and its map entry go with it
  const second = buildRuleset({ ...BASE, slots: SLOTS.filter((slot) => slot.slot !== 1) });

  const changes =
    buildElementChange('add', 1, ['192.0.2.7', '192.0.2.8', '2001:db8:b::2']) +
    buildElementChange('delete', 1, ['140.82.112.3', '2001:db8:b::1']);

  const listed = runNft(
    { FIRST: first, CHANGES: changes, SECOND: second },
    `
printf '%s' "$FIRST" | nft -f -
printf '%s' "$FIRST" | nft -f -
printf '%s' "$CHANGES" | nft -f -
nft list set inet imp_egress allow1 | grep elements
nft list set inet imp_egress allow61 | grep elements
nft list map inet imp_egress slots | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
printf '%s' "$SECOND" | nft -f -
nft list map inet imp_egress slots | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
nft list set inet imp_egress allow1 2>&1 | head -1 || true
`,
  );

  expect(listed.split('\n').map((line) => line.trim())).toEqual([
    'elements = { 192.0.2.7, 192.0.2.8 }',
    'elements = { 2001:db8:b::2 }',
    'elements = { "imp0" : jump slot0, "imp1" : jump slot1, "imp2" : jump slot2 }',
    'elements = { "imp0" : jump slot0, "imp2" : jump slot2 }',
    'Error: No such file or directory',
    '',
  ]);
});

test.skipIf(!canUnshare)(
  'every slot chain checks both sources, and the NAT66 table applies',
  () => {
    const table = buildRuleset({
      ...BASE,
      slots: SLOTS,
    });

    const listed = runNft(
      { TABLE: table, NAT66: buildNat66Ruleset('fd12:3456:789a::/64', 'eth0') },
      `
printf '%s' "$TABLE" | nft -f -
printf '%s' "$NAT66" | nft -f -
printf '%s' "$NAT66" | nft -f -
for slot in 0 1 2; do nft list chain inet imp_egress slot$slot | grep -E 'saddr|nfproto|ip6' ; done
nft list chain ip6 imp_nat66 postrouting | grep masquerade
`,
    );

    expect(listed.split('\n').map((line) => line.trim())).toEqual([
      'ip saddr != 10.66.0.2 drop',
      'ip6 saddr != fd12:3456:789a::a42:2 drop',
      'ip6 daddr @blocked6 goto deny',
      'ip saddr != 10.66.0.6 drop',
      'ip6 saddr != fd12:3456:789a::a42:6 drop',
      'ip6 daddr @cidr61 accept',
      'ip6 daddr @blocked6 goto deny',
      'ip6 daddr @allow61 accept',
      'ip saddr != 10.66.0.10 drop',
      'meta nfproto ipv6 drop',
      'oifname "eth0" ip6 saddr fd12:3456:789a::/64 masquerade',
      '',
    ]);
  },
);

test.skipIf(!canUnshare)('nft takes networks, and a member that leaves leaves its set', () => {
  const joined = buildRuleset({
    ...BASE,
    slots: SLOTS,
    networks: [
      [
        { tap: 'imp0', guestIp: '10.66.0.2' },
        { tap: 'imp1', guestIp: '10.66.0.6' },
      ],
      [
        { tap: 'imp1', guestIp: '10.66.0.6' },
        { tap: 'imp2', guestIp: '10.66.0.10' },
      ],
    ],
  });

  const left = buildRuleset({
    ...BASE,
    slots: SLOTS,
    networks: [[{ tap: 'imp1', guestIp: '10.66.0.6' }]],
  });

  const listed = runNft(
    { JOINED: joined, LEFT: left },
    `
printf '%s' "$JOINED" | nft -f -
nft list set inet imp_egress net0 | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
nft list set inet imp_egress open_peer_taps | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
printf '%s' "$LEFT" | nft -f -
nft list set inet imp_egress net0 | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
nft list set inet imp_egress net1 2>&1 | head -1 || true
`,
  );

  expect(listed.split('\n').map((line) => line.trim())).toEqual([
    'elements = { "imp0" . 10.66.0.2, "imp1" . 10.66.0.6 }',
    'elements = { "imp0" }',
    'elements = { "imp1" . 10.66.0.6 }',
    'Error: No such file or directory',
    '',
  ]);
});
