import { expect, test } from 'bun:test';
import { REFUSED_RANGES } from '../../packages/daemon/src/broker/tunnel-target';
import {
  buildElementChange,
  buildNat66Ruleset,
  buildRuleset,
} from '../../packages/daemon/src/egress/egress-ruleset';
import type { FirewallSlot } from '../../packages/daemon/src/egress/egress-ruleset';
import { BLOCKED_RANGES6, DOCUMENTATION_RANGES6 } from '../../packages/daemon/src/net/ranges6';
import { buildUnshare } from './unshare';

// impd's table, applied by the real nft in a fresh user and network
// namespace. Skipped where that is not allowed, or nft is missing, unless
// IMP_HOST_TESTS=required, as in CI's root step.
const canUnshare =
  process.env['IMP_HOST_TESTS'] === 'required' ||
  Bun.spawnSync([...buildUnshare(), 'nft', 'list', 'ruleset'], {
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
  public4: PRIVATE,
  public6: [...BLOCKED6, ...DOCUMENTATION_RANGES6],
  uplinks4: ['eth0'],
  uplinks6: ['eth0'],
  dnsPort: 7053,
  setSize: 4096,
};

function runNft(scripts: Readonly<Record<string, string>>, after: string): string {
  const result = Bun.spawnSync([...buildUnshare(), 'bash', '-euo', 'pipefail', '-c', after], {
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

// Three guests behind veth pairs named as taps, and setup-net's two FORWARD
// rules: g0 on lab, g1 on lab and ops, g2 on ops. g1 counts the pings from
// g0's address, so a spoofed one that arrives shows.
const GUESTS = `
mount -t tmpfs tmpfs /run
mkdir -p /run/netns
sysctl -qw net.ipv4.ip_forward=1
for n in 0 1 2; do
  ip netns add g$n
  ip link add imp$n type veth peer name eth0 netns g$n
  ip addr add 10.66.0.$((n * 4 + 1))/30 dev imp$n
  ip link set imp$n up
  ip -n g$n addr add 10.66.0.$((n * 4 + 2))/30 dev eth0
  ip -n g$n link set eth0 up
  ip -n g$n link set lo up
  ip -n g$n route add default via 10.66.0.$((n * 4 + 1))
done
ip netns exec g1 nft -f - <<'NFT'
table inet count {
  chain input {
    type filter hook input priority 0; policy accept;
    ip saddr 10.66.0.2 icmp type echo-request counter name from_g0
  }
  counter from_g0 {}
}
NFT
iptables -A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -m comment --comment imp-network -j ACCEPT
iptables -A FORWARD -i imp+ -o imp+ -j DROP
printf '%s' "$TABLE" | nft -f -
reach() { ip netns exec "$1" ping -c 1 -W 1 "$2" >/dev/null 2>&1 && echo "$1>$2 yes" || echo "$1>$2 no"; }
counted() { ip netns exec g1 nft list counter inet count from_g0 | grep -o 'packets [0-9]*'; }
`;

test.skipIf(!canUnshare)(
  'packets: a network joins only its own members, each from its own tap',
  () => {
    const table = buildRuleset({
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

    const result = Bun.spawnSync(
      [
        ...buildUnshare(true),
        'bash',
        '-euo',
        'pipefail',
        '-c',
        `${GUESTS}
reach g0 10.66.0.6
reach g1 10.66.0.10
reach g2 10.66.0.6
reach g0 10.66.0.10
reach g2 10.66.0.2
counted
ip -n g2 addr add 10.66.0.2/32 dev eth0
ip netns exec g2 ping -c 1 -W 1 -I 10.66.0.2 10.66.0.6 >/dev/null 2>&1 || true
counted
`,
      ],
      { env: { ...process.env, TABLE: table } },
    );

    expect(result.stderr.toString()).toBe('');

    // the spoofed ping from g2's tap with g0's address never reaches g1
    expect(result.stdout.toString().trim().split('\n')).toEqual([
      'g0>10.66.0.6 yes',
      'g1>10.66.0.10 yes',
      'g2>10.66.0.6 yes',
      'g0>10.66.0.10 no',
      'g2>10.66.0.2 no',
      'packets 1',
      'packets 1',
    ]);
  },
);

// A public guest (g3) and an open one (g0); the uplink up0 on a public /24
// whose neighbour wan answers on public, private and special addresses, and
// tailscale0 with a public-looking subnet route to ts.
const PUBLIC_NET = `
mount -t tmpfs tmpfs /run
mkdir -p /run/netns
sysctl -qw net.ipv4.ip_forward=1
sysctl -qw net.ipv6.conf.all.forwarding=1
for n in 0 3; do
  ip netns add g$n
  ip link add imp$n type veth peer name eth0 netns g$n
  ip addr add 10.66.0.$((n * 4 + 1))/30 dev imp$n
  ip -6 addr add fd12:3456:789a::$n:1/112 dev imp$n nodad
  ip link set imp$n up
  ip -n g$n addr add 10.66.0.$((n * 4 + 2))/30 dev eth0
  ip -n g$n -6 addr add fd12:3456:789a::$n:2/112 dev eth0 nodad
  ip -n g$n link set eth0 up
  ip -n g$n link set lo up
  ip -n g$n route add default via 10.66.0.$((n * 4 + 1))
  ip -n g$n -6 route add default via fd12:3456:789a::$n:1
done
ip netns add wan
ip link add up0 type veth peer name eth0 netns wan
ip addr add 44.0.0.1/24 dev up0
ip -6 addr add 2a00:44::1/64 dev up0 nodad
ip link set up0 up
ip -n wan addr add 44.0.0.2/24 dev eth0
ip -n wan -6 addr add 2a00:44::2/64 dev eth0 nodad
ip -n wan link set eth0 up
ip -n wan link set lo up
for address in 93.184.215.14 10.250.77.1 169.254.169.254 192.88.99.1 8.8.4.4; do
  ip -n wan addr add $address/32 dev lo
done
for address in 2606:4700::1111 64:ff9b::a00:1 2002:a00:1::1 2001:db8:77::1 2a01:4f8::7; do
  ip -n wan -6 addr add $address/128 dev lo nodad
done
ip -n wan route add 10.66.0.0/16 via 44.0.0.1
ip -n wan -6 route add fd12:3456:789a::/64 via 2a00:44::1
ip route add default via 44.0.0.2
ip -6 route add default via 2a00:44::2
ip netns add ts
ip link add tailscale0 type veth peer name eth0 netns ts
ip addr add 100.90.0.1/24 dev tailscale0
ip link set tailscale0 up
ip -n ts addr add 100.90.0.2/24 dev eth0
ip -n ts addr add 1.2.3.4/32 dev lo
ip -n ts link set eth0 up
ip -n ts link set lo up
ip -n ts route add 10.66.0.0/16 via 100.90.0.1
ip route add 1.2.3.0/24 via 100.90.0.2 dev tailscale0
printf '%s' "$TABLE" | nft -f -
# IPv6 neighbour discovery takes a second a hop on a first packet; a refusal
# comes back at once as ICMP admin-prohibited
reach() { ip netns exec "$1" ping -c 1 -W 4 "$2" >/dev/null 2>&1 && echo "$1>$2 yes" || echo "$1>$2 no"; }
`;

test.skipIf(!canUnshare)('packets: a public imp reaches the internet only, in each family', () => {
  const slots: readonly FirewallSlot[] = [0, 3].map((slot) => ({
    slot,
    tap: `imp${String(slot)}`,
    guestIp: `10.66.0.${String(slot * 4 + 2)}`,
    guestIp6: `fd12:3456:789a::${String(slot)}:2`,
    mode: slot === 0 ? 'open' : 'public',
    cidrs: [],
    addresses: [],
  }));

  // the host's own networks as impd reads them, and IMP_EGRESS_DENY
  const table = buildRuleset({
    ...BASE,
    slots,
    blocked6: [...BLOCKED6, '2a00:44::/64'],
    public4: [...PRIVATE, '44.0.0.0/24', '44.0.0.1/32', '100.90.0.0/24', '8.8.4.4/32'],
    public6: [...BLOCKED6, '2a00:44::/64', ...DOCUMENTATION_RANGES6, '2a01:4f8::7/128'],
    uplinks4: ['up0'],
    uplinks6: ['up0'],
  });

  const targets = [
    '93.184.215.14',
    '2606:4700::1111',
    '10.250.77.1',
    '169.254.169.254',
    '192.88.99.1',
    '44.0.0.2',
    '8.8.4.4',
    '1.2.3.4',
    '64:ff9b::a00:1',
    '2002:a00:1::1',
    '2001:db8:77::1',
    '2a00:44::2',
    '2a01:4f8::7',
  ];

  const result = Bun.spawnSync(
    [
      ...buildUnshare(true),
      'bash',
      '-euo',
      'pipefail',
      '-c',
      `${PUBLIC_NET}
for target in ${targets.join(' ')}; do reach g3 $target; done
for target in 10.250.77.1 44.0.0.2 8.8.4.4 1.2.3.4 2001:db8:77::1; do reach g0 $target; done
`,
    ],
    { env: { ...process.env, TABLE: table } },
  );

  expect(result.stderr.toString()).toBe('');

  // the public addresses, and nothing else; the open imp, as a control,
  // reaches what the public one is refused by address and by route
  expect(result.stdout.toString().trim().split('\n')).toEqual([
    'g3>93.184.215.14 yes',
    'g3>2606:4700::1111 yes',
    ...targets.slice(2).map((target) => `g3>${target} no`),
    'g0>10.250.77.1 yes',
    'g0>44.0.0.2 yes',
    'g0>8.8.4.4 yes',
    'g0>1.2.3.4 yes',
    'g0>2001:db8:77::1 yes',
  ]);
});

test.skipIf(!canUnshare)('packets: with no default route, a public imp reaches nothing', () => {
  const table = buildRuleset({
    ...BASE,
    slots: [
      {
        slot: 3,
        tap: 'imp3',
        guestIp: '10.66.0.14',
        guestIp6: 'fd12:3456:789a::3:2',
        mode: 'public',
        cidrs: [],
        addresses: [],
      },
    ],
    uplinks4: [],
    uplinks6: [],
  });

  const result = Bun.spawnSync(
    [
      ...buildUnshare(true),
      'bash',
      '-euo',
      'pipefail',
      '-c',
      `${PUBLIC_NET}
reach g3 93.184.215.14
reach g3 2606:4700::1111
`,
    ],
    { env: { ...process.env, TABLE: table } },
  );

  expect(result.stderr.toString()).toBe('');

  expect(result.stdout.toString().trim().split('\n')).toEqual([
    'g3>93.184.215.14 no',
    'g3>2606:4700::1111 no',
  ]);
});

test.skipIf(!canUnshare)(
  'packets: with no ip6tables rules, a guest reaches the host container over IPv6 only for neighbour discovery',
  () => {
    const slots: readonly FirewallSlot[] = [0, 3].map((slot) => ({
      slot,
      tap: `imp${String(slot)}`,
      guestIp: `10.66.0.${String(slot * 4 + 2)}`,
      guestIp6: `fd12:3456:789a::${String(slot)}:2`,
      mode: slot === 0 ? 'open' : 'public',
      cidrs: [],
      addresses: [],
    }));

    const table = buildRuleset({ ...BASE, slots, uplinks4: ['up0'], uplinks6: ['up0'] });

    // the namespace has no ip6tables rules, as a container without ip6tables;
    // the gateway's link-local address and its own on the tap, then IPv4 and
    // the internet as controls (neighbour discovery must still pass)
    const result = Bun.spawnSync(
      [
        ...buildUnshare(true),
        'bash',
        '-euo',
        'pipefail',
        '-c',
        `${PUBLIC_NET}
quick() { ip netns exec "$1" ping -c 1 -W 1 "$2" >/dev/null 2>&1 && echo "$1>$3 yes" || echo "$1>$3 no"; }
for n in 0 3; do
  local6=$(ip -6 addr show dev imp$n scope link | awk '/inet6/ { sub("/.*", "", $2); print $2 }')
  quick g$n "$local6%eth0" link-local
  quick g$n fd12:3456:789a::$n:1 tap6
  quick g$n 10.66.0.$((n * 4 + 1)) tap4
  reach g$n 2606:4700::1111
done
`,
      ],
      { env: { ...process.env, TABLE: table } },
    );

    expect(result.stderr.toString()).toBe('');

    expect(result.stdout.toString().trim().split('\n')).toEqual([
      'g0>link-local no',
      'g0>tap6 no',
      'g0>tap4 yes',
      'g0>2606:4700::1111 yes',
      'g3>link-local no',
      'g3>tap6 no',
      'g3>tap4 yes',
      'g3>2606:4700::1111 yes',
    ]);
  },
);
