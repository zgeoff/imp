import { expect, test } from 'bun:test';
import { REFUSED_RANGES } from '../broker/tunnel-target';
import { BLOCKED_RANGES6, DOCUMENTATION_RANGES6 } from '../net/ranges6';
import { buildStubPublicNetwork } from '../test-utils/build-stub-public-network';
import { canUnshare } from '../test-utils/can-unshare';
import { runInNetns } from '../test-utils/run-in-netns';
import {
  buildElementChange,
  buildNat66Removal,
  buildNat66Ruleset,
  buildRuleset,
} from './egress-ruleset';

// impd's table, applied by the real nft in a fresh network namespace, through
// a user namespace when not root. Each test skips where that is not allowed,
// or a tool it runs is missing, unless IMP_HOST_TESTS=required: `bun run test:host`.

test.skipIf(!canUnshare(['nft', 'list', 'ruleset']))(
  '#buildRuleset applies over the table it already applied',
  () => {
    const table = buildRuleset({
      slots: [
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
      ],
      networks: [],
      subnet: '10.66.0.0/16',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
      privateRanges: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
      public4: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      public6: [
        ...BLOCKED_RANGES6,
        'fd12:3456:789a::/64',
        '2001:db8:a::/64',
        ...DOCUMENTATION_RANGES6,
      ],
      uplinks4: ['eth0'],
      uplinks6: ['eth0'],
      dnsPort: 7053,
      setSize: 4096,
    });

    const run = runInNetns({
      script: `
printf '%s' "$TABLE" | nft -f -
printf '%s' "$TABLE" | nft -f -
nft list map inet imp_egress slots | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
`,
      env: { TABLE: table },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout: 'elements = { "imp0" : jump slot0, "imp1" : jump slot1, "imp2" : jump slot2 }\n',
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(!canUnshare(['nft', 'list', 'ruleset']))(
  "#buildElementChange adds and deletes a box slot's allowed addresses in each family",
  () => {
    const table = buildRuleset({
      slots: [
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
      ],
      networks: [],
      subnet: '10.66.0.0/16',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
      privateRanges: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
      public4: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      public6: [
        ...BLOCKED_RANGES6,
        'fd12:3456:789a::/64',
        '2001:db8:a::/64',
        ...DOCUMENTATION_RANGES6,
      ],
      uplinks4: ['eth0'],
      uplinks6: ['eth0'],
      dnsPort: 7053,
      setSize: 4096,
    });

    const changes =
      buildElementChange('add', 1, ['192.0.2.7', '192.0.2.8', '2001:db8:b::2']) +
      buildElementChange('delete', 1, ['140.82.112.3', '2001:db8:b::1']);

    const run = runInNetns({
      script: `
printf '%s' "$TABLE" | nft -f -
printf '%s' "$CHANGES" | nft -f -
nft list set inet imp_egress allow1 | grep elements
nft list set inet imp_egress allow61 | grep elements
`,
      env: { TABLE: table, CHANGES: changes },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout: '\t\telements = { 192.0.2.7, 192.0.2.8 }\n\t\telements = { 2001:db8:b::2 }\n',
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(!canUnshare(['nft', 'list', 'ruleset']))(
  '#buildRuleset drops the set and map entry of a slot that is gone',
  () => {
    const first = buildRuleset({
      slots: [
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
      ],
      networks: [],
      subnet: '10.66.0.0/16',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
      privateRanges: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
      public4: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      public6: [
        ...BLOCKED_RANGES6,
        'fd12:3456:789a::/64',
        '2001:db8:a::/64',
        ...DOCUMENTATION_RANGES6,
      ],
      uplinks4: ['eth0'],
      uplinks6: ['eth0'],
      dnsPort: 7053,
      setSize: 4096,
    });

    // slot 1 gone, as after an imp rm
    const second = buildRuleset({
      slots: [
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
          slot: 2,
          tap: 'imp2',
          guestIp: '10.66.0.10',
          guestIp6: null,
          mode: 'none',
          cidrs: [],
          addresses: [],
        },
      ],
      networks: [],
      subnet: '10.66.0.0/16',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
      privateRanges: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
      public4: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      public6: [
        ...BLOCKED_RANGES6,
        'fd12:3456:789a::/64',
        '2001:db8:a::/64',
        ...DOCUMENTATION_RANGES6,
      ],
      uplinks4: ['eth0'],
      uplinks6: ['eth0'],
      dnsPort: 7053,
      setSize: 4096,
    });

    const run = runInNetns({
      script: `
printf '%s' "$FIRST" | nft -f -
printf '%s' "$SECOND" | nft -f -
nft list map inet imp_egress slots | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
nft list set inet imp_egress allow1 2>&1 | head -1 || true
`,
      env: { FIRST: first, SECOND: second },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout:
        'elements = { "imp0" : jump slot0, "imp2" : jump slot2 }\nError: No such file or directory\n',
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(!canUnshare(['nft', 'list', 'ruleset']))(
  '#buildRuleset checks both source addresses in every slot chain',
  () => {
    const table = buildRuleset({
      slots: [
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
      ],
      networks: [],
      subnet: '10.66.0.0/16',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
      privateRanges: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
      public4: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      public6: [
        ...BLOCKED_RANGES6,
        'fd12:3456:789a::/64',
        '2001:db8:a::/64',
        ...DOCUMENTATION_RANGES6,
      ],
      uplinks4: ['eth0'],
      uplinks6: ['eth0'],
      dnsPort: 7053,
      setSize: 4096,
    });

    const run = runInNetns({
      script: `
printf '%s' "$TABLE" | nft -f -
for slot in 0 1 2; do nft list chain inet imp_egress slot$slot | grep -E 'saddr|nfproto|ip6' | sed 's/^[[:space:]]*//'; done
`,
      env: { TABLE: table },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout: [
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
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(!canUnshare(['nft', 'list', 'ruleset']))(
  "#buildNat66Ruleset masquerades the guests' prefix out the uplink, applied twice",
  () => {
    const nat66 = buildNat66Ruleset('fd12:3456:789a::/64', 'eth0');

    const run = runInNetns({
      script: `
printf '%s' "$NAT66" | nft -f -
printf '%s' "$NAT66" | nft -f -
nft list chain ip6 imp_nat66 postrouting | grep masquerade | sed 's/^[[:space:]]*//'
`,
      env: { NAT66: nat66 },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout: 'oifname "eth0" ip6 saddr fd12:3456:789a::/64 masquerade\n',
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(!canUnshare(['nft', 'list', 'ruleset']))(
  '#buildNat66Removal applies where there is no NAT66 table',
  () => {
    const removal = buildNat66Removal();

    const run = runInNetns({
      script: `
printf '%s' "$REMOVAL" | nft -f -
nft list tables
`,
      env: { REMOVAL: removal },
      mount: false,
    });

    expect(run).toStrictEqual({ stdout: '', stderr: '', exitCode: 0 });
  },
);

test.skipIf(!canUnshare(['nft', 'list', 'ruleset']))(
  '#buildNat66Removal removes the NAT66 table',
  () => {
    const nat66 = buildNat66Ruleset('fd12:3456:789a::/64', 'eth0');
    const removal = buildNat66Removal();

    const run = runInNetns({
      script: `
printf '%s' "$NAT66" | nft -f -
nft list tables
printf '%s' "$REMOVAL" | nft -f -
nft list tables
`,
      env: { NAT66: nat66, REMOVAL: removal },
      mount: false,
    });

    expect(run).toStrictEqual({ stdout: 'table ip6 imp_nat66\n', stderr: '', exitCode: 0 });
  },
);

test.skipIf(!canUnshare(['nft', 'list', 'ruleset']))(
  "#buildRuleset lists each network's members and the open imps' taps",
  () => {
    const table = buildRuleset({
      slots: [
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
      ],
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
      subnet: '10.66.0.0/16',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
      privateRanges: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
      public4: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      public6: [
        ...BLOCKED_RANGES6,
        'fd12:3456:789a::/64',
        '2001:db8:a::/64',
        ...DOCUMENTATION_RANGES6,
      ],
      uplinks4: ['eth0'],
      uplinks6: ['eth0'],
      dnsPort: 7053,
      setSize: 4096,
    });

    const run = runInNetns({
      script: `
printf '%s' "$TABLE" | nft -f -
nft list set inet imp_egress net0 | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
nft list set inet imp_egress open_peer_taps | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
`,
      env: { TABLE: table },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout: 'elements = { "imp0" . 10.66.0.2, "imp1" . 10.66.0.6 }\nelements = { "imp0" }\n',
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(!canUnshare(['nft', 'list', 'ruleset']))(
  '#buildRuleset drops a member that leaves, and a network left with one member',
  () => {
    const joined = buildRuleset({
      slots: [
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
      ],
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
      subnet: '10.66.0.0/16',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
      privateRanges: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
      public4: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      public6: [
        ...BLOCKED_RANGES6,
        'fd12:3456:789a::/64',
        '2001:db8:a::/64',
        ...DOCUMENTATION_RANGES6,
      ],
      uplinks4: ['eth0'],
      uplinks6: ['eth0'],
      dnsPort: 7053,
      setSize: 4096,
    });

    const left = buildRuleset({
      slots: [
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
      ],
      networks: [[{ tap: 'imp1', guestIp: '10.66.0.6' }]],
      subnet: '10.66.0.0/16',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
      privateRanges: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
      public4: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      public6: [
        ...BLOCKED_RANGES6,
        'fd12:3456:789a::/64',
        '2001:db8:a::/64',
        ...DOCUMENTATION_RANGES6,
      ],
      uplinks4: ['eth0'],
      uplinks6: ['eth0'],
      dnsPort: 7053,
      setSize: 4096,
    });

    const run = runInNetns({
      script: `
printf '%s' "$JOINED" | nft -f -
printf '%s' "$LEFT" | nft -f -
nft list set inet imp_egress net0 | tr -s '\\n\\t ' ' ' | grep -o 'elements = {[^}]*}'
nft list set inet imp_egress net1 2>&1 | head -1 || true
`,
      env: { JOINED: joined, LEFT: left },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout: 'elements = { "imp1" . 10.66.0.6 }\nError: No such file or directory\n',
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(
  !canUnshare([
    'sh',
    '-c',
    'nft list ruleset && iptables -S && ip link && command -v ping && command -v sysctl',
  ]),
)("#buildRuleset lets a network's members reach only one another, each from its own tap", () => {
  const table = buildRuleset({
    slots: [
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
    ],
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
    subnet: '10.66.0.0/16',
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    privateRanges: [
      ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
      '10.66.0.0/16',
    ],
    blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
    public4: [
      ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
      '10.66.0.0/16',
    ],
    public6: [
      ...BLOCKED_RANGES6,
      'fd12:3456:789a::/64',
      '2001:db8:a::/64',
      ...DOCUMENTATION_RANGES6,
    ],
    uplinks4: ['eth0'],
    uplinks6: ['eth0'],
    dnsPort: 7053,
    setSize: 4096,
  });

  // three guests behind veth pairs named as taps, and setup-net's two FORWARD
  // rules: g0 on lab, g1 on lab and ops, g2 on ops. g1 counts the pings from
  // g0's address, so a spoofed one that arrives shows.
  const run = runInNetns({
    script: `
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
    env: { TABLE: table },
    mount: true,
  });

  // the spoofed ping from g2's tap with g0's address never reaches g1
  expect(run).toStrictEqual({
    stdout: [
      'g0>10.66.0.6 yes',
      'g1>10.66.0.10 yes',
      'g2>10.66.0.6 yes',
      'g0>10.66.0.10 no',
      'g2>10.66.0.2 no',
      'packets 1',
      'packets 1',
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  });
});

test.skipIf(
  !canUnshare([
    'sh',
    '-c',
    'nft list ruleset && iptables -S && ip link && command -v ping && command -v sysctl',
  ]),
)('#buildRuleset lets a public imp reach only public addresses, in each family', () => {
  // the host's own networks as impd reads them, and IMP_EGRESS_DENY
  const table = buildRuleset({
    slots: [
      {
        slot: 0,
        tap: 'imp0',
        guestIp: '10.66.0.2',
        guestIp6: 'fd12:3456:789a::0:2',
        mode: 'open',
        cidrs: [],
        addresses: [],
      },
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
    networks: [],
    subnet: '10.66.0.0/16',
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    privateRanges: [
      ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
      '10.66.0.0/16',
    ],
    blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64', '2a00:44::/64'],
    public4: [
      ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
      '10.66.0.0/16',
      '44.0.0.0/24',
      '44.0.0.1/32',
      '100.90.0.0/24',
      '8.8.4.4/32',
    ],
    public6: [
      ...BLOCKED_RANGES6,
      'fd12:3456:789a::/64',
      '2001:db8:a::/64',
      '2a00:44::/64',
      ...DOCUMENTATION_RANGES6,
      '2a01:4f8::7/128',
    ],
    uplinks4: ['up0'],
    uplinks6: ['up0'],
    dnsPort: 7053,
    setSize: 4096,
  });

  // a refusal comes back at once as ICMP admin-prohibited; the open imp, as a
  // control, reaches what the public one is refused by address and by route
  const run = runInNetns({
    script: `${buildStubPublicNetwork()}
printf '%s' "$TABLE" | nft -f -
reach() { ip netns exec "$1" ping -c 1 -W 4 "$2" >/dev/null 2>&1 && echo "$1>$2 yes" || echo "$1>$2 no"; }
for target in 93.184.215.14 2606:4700::1111 10.250.77.1 169.254.169.254 192.88.99.1 44.0.0.2 8.8.4.4 1.2.3.4 64:ff9b::a00:1 2002:a00:1::1 2001:db8:77::1 2a00:44::2 2a01:4f8::7; do reach g3 $target; done
for target in 10.250.77.1 44.0.0.2 8.8.4.4 1.2.3.4 2001:db8:77::1; do reach g0 $target; done
`,
    env: { TABLE: table },
    mount: true,
  });

  expect(run).toStrictEqual({
    stdout: [
      'g3>93.184.215.14 yes',
      'g3>2606:4700::1111 yes',
      'g3>10.250.77.1 no',
      'g3>169.254.169.254 no',
      'g3>192.88.99.1 no',
      'g3>44.0.0.2 no',
      'g3>8.8.4.4 no',
      'g3>1.2.3.4 no',
      'g3>64:ff9b::a00:1 no',
      'g3>2002:a00:1::1 no',
      'g3>2001:db8:77::1 no',
      'g3>2a00:44::2 no',
      'g3>2a01:4f8::7 no',
      'g0>10.250.77.1 yes',
      'g0>44.0.0.2 yes',
      'g0>8.8.4.4 yes',
      'g0>1.2.3.4 yes',
      'g0>2001:db8:77::1 yes',
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  });
});

test.skipIf(
  !canUnshare([
    'sh',
    '-c',
    'nft list ruleset && iptables -S && ip link && command -v ping && command -v sysctl',
  ]),
)('#buildRuleset lets a public imp reach nothing when impd reads no uplinks', () => {
  const table = buildRuleset({
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
    networks: [],
    subnet: '10.66.0.0/16',
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    privateRanges: [
      ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
      '10.66.0.0/16',
    ],
    blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
    public4: [
      ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
      '10.66.0.0/16',
    ],
    public6: [
      ...BLOCKED_RANGES6,
      'fd12:3456:789a::/64',
      '2001:db8:a::/64',
      ...DOCUMENTATION_RANGES6,
    ],
    uplinks4: [],
    uplinks6: [],
    dnsPort: 7053,
    setSize: 4096,
  });

  const run = runInNetns({
    script: `${buildStubPublicNetwork()}
printf '%s' "$TABLE" | nft -f -
reach() { ip netns exec "$1" ping -c 1 -W 4 "$2" >/dev/null 2>&1 && echo "$1>$2 yes" || echo "$1>$2 no"; }
reach g3 93.184.215.14
reach g3 2606:4700::1111
`,
    env: { TABLE: table },
    mount: true,
  });

  expect(run).toStrictEqual({
    stdout: 'g3>93.184.215.14 no\ng3>2606:4700::1111 no\n',
    stderr: '',
    exitCode: 0,
  });
});

test.skipIf(
  !canUnshare([
    'sh',
    '-c',
    'nft list ruleset && iptables -S && ip link && command -v ping && command -v sysctl',
  ]),
)(
  '#buildRuleset refuses a guest the host container over IPv6 but for neighbour discovery, with no ip6tables rules',
  () => {
    const table = buildRuleset({
      slots: [
        {
          slot: 0,
          tap: 'imp0',
          guestIp: '10.66.0.2',
          guestIp6: 'fd12:3456:789a::0:2',
          mode: 'open',
          cidrs: [],
          addresses: [],
        },
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
      networks: [],
      subnet: '10.66.0.0/16',
      dnsServers: ['1.1.1.1', '8.8.8.8'],
      privateRanges: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      blocked6: [...BLOCKED_RANGES6, 'fd12:3456:789a::/64', '2001:db8:a::/64'],
      public4: [
        ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
        '10.66.0.0/16',
      ],
      public6: [
        ...BLOCKED_RANGES6,
        'fd12:3456:789a::/64',
        '2001:db8:a::/64',
        ...DOCUMENTATION_RANGES6,
      ],
      uplinks4: ['up0'],
      uplinks6: ['up0'],
      dnsPort: 7053,
      setSize: 4096,
    });

    // the namespace has no ip6tables rules, as a container without ip6tables;
    // the gateway's link-local address and its own on the tap, then IPv4 and
    // the internet as controls (neighbour discovery must still pass)
    const run = runInNetns({
      script: `${buildStubPublicNetwork()}
printf '%s' "$TABLE" | nft -f -
reach() { ip netns exec "$1" ping -c 1 -W 4 "$2" >/dev/null 2>&1 && echo "$1>$2 yes" || echo "$1>$2 no"; }
quick() { ip netns exec "$1" ping -c 1 -W 1 "$2" >/dev/null 2>&1 && echo "$1>$3 yes" || echo "$1>$3 no"; }
for n in 0 3; do
  local6=$(ip -6 addr show dev imp$n scope link | awk '/inet6/ { sub("/.*", "", $2); print $2 }')
  quick g$n "$local6%eth0" link-local
  quick g$n fd12:3456:789a::$n:1 tap6
  quick g$n 10.66.0.$((n * 4 + 1)) tap4
  reach g$n 2606:4700::1111
done
`,
      env: { TABLE: table },
      mount: true,
    });

    expect(run).toStrictEqual({
      stdout: [
        'g0>link-local no',
        'g0>tap6 no',
        'g0>tap4 yes',
        'g0>2606:4700::1111 yes',
        'g3>link-local no',
        'g3>tap6 no',
        'g3>tap4 yes',
        'g3>2606:4700::1111 yes',
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });
  },
);
