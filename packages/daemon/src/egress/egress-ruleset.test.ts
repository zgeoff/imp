import { expect, test } from 'bun:test';
import { REFUSED_RANGES } from '../broker/tunnel-target';
import { BLOCKED_RANGES6, DOCUMENTATION_RANGES6 } from '../net/ranges6';
import { buildMockFirewallSlot } from '../test-utils/build-mock-firewall-slot';
import { buildStubPublicNetwork } from '../test-utils/build-stub-public-network';
import { canUnshare } from '../test-utils/can-unshare';
import { runInNetns } from '../test-utils/run-in-netns';
import {
  buildElementChange,
  buildNat66Removal,
  buildNat66Ruleset,
  buildRuleset,
} from './egress-ruleset';

test('#buildRuleset writes the whole table for one slot of each mode and a network', () => {
  const script = buildRuleset({
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
        guestIp6: null,
        mode: 'box',
        cidrs: ['203.0.113.0/24', '2001:db8:c::/48'],
        addresses: ['140.82.112.3', '2606:50c0:8000::153'],
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
      {
        slot: 3,
        tap: 'imp3',
        guestIp: '10.66.0.14',
        guestIp6: null,
        mode: 'public',
        cidrs: [],
        addresses: [],
      },
    ],
    networks: [
      [
        { tap: 'imp0', guestIp: '10.66.0.2' },
        { tap: 'imp1', guestIp: '10.66.0.6' },
      ],
    ],
    subnet: '10.66.0.0/16',
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    privateRanges: ['10.0.0.0/8', '10.66.0.0/16'],
    blocked6: ['fc00::/7', 'fd12:3456:789a::/64'],
    public4: ['10.0.0.0/8', '172.17.0.0/16'],
    public6: ['fc00::/7', '2001:db8::/32'],
    uplinks4: ['eth0'],
    uplinks6: ['eth0'],
    dnsPort: 5353,
    setSize: 4096,
  });

  expect(script).toMatchInlineSnapshot(`
    "table inet imp_egress {}
    delete table inet imp_egress
    table inet imp_egress {
      set private {
        type ipv4_addr
        flags interval
        auto-merge
        elements = { 10.0.0.0/8, 10.66.0.0/16 }
      }
      set blocked6 {
        type ipv6_addr
        flags interval
        auto-merge
        elements = { fc00::/7, fd12:3456:789a::/64 }
      }
      set public4 {
        type ipv4_addr
        flags interval
        auto-merge
        elements = { 10.0.0.0/8, 172.17.0.0/16 }
      }
      set public6 {
        type ipv6_addr
        flags interval
        auto-merge
        elements = { fc00::/7, 2001:db8::/32 }
      }
      set uplinks4 {
        type ifname
        elements = { "eth0" }
      }
      set uplinks6 {
        type ifname
        elements = { "eth0" }
      }
      set dns_taps {
        type ifname
        elements = { "imp1", "imp2", "imp3" }
      }
      set open_peer_taps {
        type ifname
        elements = { "imp0" }
      }
      set net0 {
        type ifname . ipv4_addr
        elements = { "imp0" . 10.66.0.2, "imp1" . 10.66.0.6 }
      }
      set allow1 {
        type ipv4_addr
        size 4096
        elements = { 140.82.112.3 }
      }
      set cidr1 {
        type ipv4_addr
        flags interval
        auto-merge
        elements = { 203.0.113.0/24 }
      }
      set allow61 {
        type ipv6_addr
        size 4096
        elements = { 2606:50c0:8000::153 }
      }
      set cidr61 {
        type ipv6_addr
        flags interval
        auto-merge
        elements = { 2001:db8:c::/48 }
      }
      chain deny {
        meta l4proto tcp reject with tcp reset
        reject with icmpx admin-prohibited
      }
      chain slot0 {
        ip saddr != 10.66.0.2 drop
        ip6 saddr != fd12:3456:789a::a42:2 drop
        ip daddr { 169.254.0.0/16, 100.64.0.0/10 } goto deny
        ip6 daddr @blocked6 goto deny
        accept
      }
      chain slot1 {
        ip saddr != 10.66.0.6 drop
        meta nfproto ipv6 drop
        ct state invalid drop
        ct state established,related accept
        ip daddr @cidr1 accept
        ip daddr @private goto deny
        ip daddr @allow1 accept
        ip6 daddr @cidr61 accept
        ip6 daddr @blocked6 goto deny
        ip6 daddr @allow61 accept
        goto deny
      }
      chain slot2 {
        ip saddr != 10.66.0.10 drop
        meta nfproto ipv6 drop
        goto deny
      }
      chain slot3 {
        ip saddr != 10.66.0.14 drop
        meta nfproto ipv6 drop
        ct state invalid drop
        meta nfproto ipv4 oifname != @uplinks4 goto deny
        meta nfproto ipv6 oifname != @uplinks6 goto deny
        ip daddr @public4 goto deny
        ip6 daddr @public6 goto deny
        accept
      }
      map slots {
        type ifname : verdict
        elements = { "imp0" : jump slot0, "imp1" : jump slot1, "imp2" : jump slot2, "imp3" : jump slot3 }
      }
      chain forward {
        type filter hook forward priority filter - 1; policy accept;
        iifname != "imp*" accept
        iifname . ip saddr @net0 oifname . ip daddr @net0 meta mark set meta mark | 0x01000000 accept
        oifname "imp*" goto deny
        iifname vmap @slots
        goto deny
      }
      chain input {
        type filter hook input priority filter - 1; policy accept;
        iifname != "imp*" accept
        meta nfproto ipv4 accept
        icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 accept
        drop
      }
      chain dns {
        type nat hook prerouting priority dstnat - 1; policy accept;
        iifname @dns_taps meta nfproto ipv4 ip daddr != 10.66.0.0/16 meta l4proto { tcp, udp } th dport 53 redirect to :5353
        iifname @open_peer_taps ip daddr { 1.1.1.1, 8.8.8.8 } meta l4proto { tcp, udp } th dport 53 redirect to :5353
      }
    }
    "
  `);
});

test('#buildRuleset writes the same table for the same input', () => {
  const input = {
    slots: [
      buildMockFirewallSlot({ slot: 0, mode: 'open' }),
      buildMockFirewallSlot({ slot: 1, mode: 'box', cidrs: ['203.0.113.0/24'] }),
    ],
    networks: [[{ tap: 'imp0', guestIp: '10.66.0.2' }]],
    subnet: '10.66.0.0/16',
    dnsServers: ['1.1.1.1'],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: [],
    public6: [],
    uplinks4: [],
    uplinks6: [],
    dnsPort: 5353,
    setSize: 4096,
  };

  expect(buildRuleset(input)).toStrictEqual(buildRuleset(input));
});

test('#buildRuleset makes a network a set of tap and address pairs, checked at both ends', () => {
  const script = buildRuleset({
    slots: [
      buildMockFirewallSlot({ slot: 0, guestIp: '10.66.0.2' }),
      buildMockFirewallSlot({ slot: 1, guestIp: '10.66.0.6' }),
    ],
    networks: [
      [
        { tap: 'imp0', guestIp: '10.66.0.2' },
        { tap: 'imp1', guestIp: '10.66.0.6' },
      ],
    ],
    subnet: '10.66.0.0/16',
    dnsServers: [],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: [],
    public6: [],
    uplinks4: [],
    uplinks6: [],
    dnsPort: 5353,
    setSize: 4096,
  });

  expect(script).toInclude(
    '  set net0 {\n    type ifname . ipv4_addr\n    elements = { "imp0" . 10.66.0.2, "imp1" . 10.66.0.6 }\n  }\n',
  );

  expect(script).toInclude(
    [
      '  chain forward {',
      '    type filter hook forward priority filter - 1; policy accept;',
      '    iifname != "imp*" accept',
      '    iifname . ip saddr @net0 oifname . ip daddr @net0 meta mark set meta mark | 0x01000000 accept',
      '    oifname "imp*" goto deny',
      '    iifname vmap @slots',
      '    goto deny',
      '  }',
    ].join('\n'),
  );
});

test('#buildRuleset refuses imp to imp traffic before any policy when there are no networks', () => {
  const script = buildRuleset({
    slots: [buildMockFirewallSlot({ slot: 0 })],
    networks: [],
    subnet: '10.66.0.0/16',
    dnsServers: [],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: [],
    public6: [],
    uplinks4: [],
    uplinks6: [],
    dnsPort: 5353,
    setSize: 4096,
  });

  expect(script).toInclude(
    [
      '  chain forward {',
      '    type filter hook forward priority filter - 1; policy accept;',
      '    iifname != "imp*" accept',
      '    oifname "imp*" goto deny',
      '    iifname vmap @slots',
      '    goto deny',
      '  }',
    ].join('\n'),
  );
});

test('#buildRuleset redirects no query to an imp, and redirects an open peer only to IMP_DNS', () => {
  const script = buildRuleset({
    slots: [
      buildMockFirewallSlot({ slot: 0, mode: 'open' }),
      buildMockFirewallSlot({ slot: 1, mode: 'box' }),
    ],
    networks: [[{ tap: 'imp0', guestIp: '10.66.0.2' }]],
    subnet: '10.66.0.0/16',
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: [],
    public6: [],
    uplinks4: [],
    uplinks6: [],
    dnsPort: 5353,
    setSize: 4096,
  });

  expect(script).toInclude(
    [
      '  set dns_taps {',
      '    type ifname',
      '    elements = { "imp1" }',
      '  }',
      '  set open_peer_taps {',
      '    type ifname',
      '    elements = { "imp0" }',
      '  }',
    ].join('\n'),
  );

  expect(script).toInclude(
    [
      '  chain dns {',
      '    type nat hook prerouting priority dstnat - 1; policy accept;',
      '    iifname @dns_taps meta nfproto ipv4 ip daddr != 10.66.0.0/16 meta l4proto { tcp, udp } th dport 53 redirect to :5353',
      '    iifname @open_peer_taps ip daddr { 1.1.1.1, 8.8.8.8 } meta l4proto { tcp, udp } th dport 53 redirect to :5353',
      '  }',
    ].join('\n'),
  );
});

test('#buildRuleset redirects no open peer when IMP_DNS is empty', () => {
  const script = buildRuleset({
    slots: [buildMockFirewallSlot({ slot: 0, mode: 'open' })],
    networks: [[{ tap: 'imp0', guestIp: '10.66.0.2' }]],
    subnet: '10.66.0.0/16',
    dnsServers: [],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: [],
    public6: [],
    uplinks4: [],
    uplinks6: [],
    dnsPort: 5353,
    setSize: 4096,
  });

  expect(script).toInclude(
    [
      '  chain dns {',
      '    type nat hook prerouting priority dstnat - 1; policy accept;',
      '    iifname @dns_taps meta nfproto ipv4 ip daddr != 10.66.0.0/16 meta l4proto { tcp, udp } th dport 53 redirect to :5353',
      '  }',
    ].join('\n'),
  );
});

test('#buildRuleset lets a public slot out only by an uplink, then refuses its ranges in each family', () => {
  const script = buildRuleset({
    slots: [buildMockFirewallSlot({ slot: 3, guestIp: '10.66.0.14', mode: 'public' })],
    networks: [],
    subnet: '10.66.0.0/16',
    dnsServers: [],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: ['10.0.0.0/8', '172.17.0.0/16'],
    public6: ['fc00::/7', '2001:db8::/32'],
    uplinks4: ['eth0'],
    uplinks6: ['eth1'],
    dnsPort: 5353,
    setSize: 4096,
  });

  expect(script).toInclude(
    [
      '  set public4 {',
      '    type ipv4_addr',
      '    flags interval',
      '    auto-merge',
      '    elements = { 10.0.0.0/8, 172.17.0.0/16 }',
      '  }',
      '  set public6 {',
      '    type ipv6_addr',
      '    flags interval',
      '    auto-merge',
      '    elements = { fc00::/7, 2001:db8::/32 }',
      '  }',
      '  set uplinks4 {',
      '    type ifname',
      '    elements = { "eth0" }',
      '  }',
      '  set uplinks6 {',
      '    type ifname',
      '    elements = { "eth1" }',
      '  }',
      '  set dns_taps {',
      '    type ifname',
      '    elements = { "imp3" }',
      '  }',
    ].join('\n'),
  );

  expect(script).toInclude(
    [
      '  chain slot3 {',
      '    ip saddr != 10.66.0.14 drop',
      '    meta nfproto ipv6 drop',
      '    ct state invalid drop',
      '    meta nfproto ipv4 oifname != @uplinks4 goto deny',
      '    meta nfproto ipv6 oifname != @uplinks6 goto deny',
      '    ip daddr @public4 goto deny',
      '    ip6 daddr @public6 goto deny',
      '    accept',
      '  }',
    ].join('\n'),
  );
});

test('#buildRuleset writes empty uplink sets, which refuse a public slot everything, with no uplink', () => {
  const script = buildRuleset({
    slots: [buildMockFirewallSlot({ slot: 3, mode: 'public' })],
    networks: [],
    subnet: '10.66.0.0/16',
    dnsServers: [],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: [],
    public6: [],
    uplinks4: [],
    uplinks6: [],
    dnsPort: 5353,
    setSize: 4096,
  });

  expect(script).toInclude(
    '  set uplinks4 {\n    type ifname\n  }\n  set uplinks6 {\n    type ifname\n  }\n',
  );
});

test('#buildRuleset writes no public sets without a public slot', () => {
  const script = buildRuleset({
    slots: [buildMockFirewallSlot({ slot: 0, mode: 'box' })],
    networks: [],
    subnet: '10.66.0.0/16',
    dnsServers: [],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: ['10.0.0.0/8'],
    public6: ['fc00::/7'],
    uplinks4: ['eth0'],
    uplinks6: ['eth0'],
    dnsPort: 5353,
    setSize: 4096,
  });

  expect(script).not.toInclude('public4');
  expect(script).not.toInclude('uplinks');
});

test('#buildRuleset checks the source /128 of a slot with IPv6', () => {
  const script = buildRuleset({
    slots: [
      buildMockFirewallSlot({
        slot: 0,
        guestIp: '10.66.0.2',
        guestIp6: 'fd12:3456:789a::a42:2',
        mode: 'none',
      }),
    ],
    networks: [],
    subnet: '10.66.0.0/16',
    dnsServers: [],
    privateRanges: ['10.66.0.0/16'],
    blocked6: [],
    public4: [],
    public6: [],
    uplinks4: [],
    uplinks6: [],
    dnsPort: 5353,
    setSize: 4096,
  });

  expect(script).toInclude(
    '  chain slot0 {\n    ip saddr != 10.66.0.2 drop\n    ip6 saddr != fd12:3456:789a::a42:2 drop\n    goto deny\n  }\n',
  );
});

test('#buildElementChange splits the addresses into the IPv4 and IPv6 sets of the slot', () => {
  expect(
    buildElementChange('add', 4, ['140.82.112.3', '2606:50c0:8000::153', '140.82.112.4']),
  ).toBe(
    'add element inet imp_egress allow4 { 140.82.112.3, 140.82.112.4 }\nadd element inet imp_egress allow64 { 2606:50c0:8000::153 }\n',
  );
});

test('#buildElementChange deletes from only the family the addresses are in', () => {
  expect(buildElementChange('delete', 0, ['2606:50c0:8000::153'])).toBe(
    'delete element inet imp_egress allow60 { 2606:50c0:8000::153 }\n',
  );
});

test('#buildElementChange writes nothing for no addresses', () => {
  expect(buildElementChange('add', 0, [])).toBe('');
});

test('#buildNat66Removal deletes the NAT66 table whether or not it exists', () => {
  expect(buildNat66Removal()).toBe('table ip6 imp_nat66 {}\ndelete table ip6 imp_nat66\n');
});

test('#buildNat66Ruleset masquerades the prefix out of the uplink in a table of its own', () => {
  expect(buildNat66Ruleset('fd12:3456:789a::/64', 'eth0')).toBe(
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
});

// The host tests apply impd's table with the real nft in a fresh network
// namespace, in a user namespace when not root. Each skips where it cannot,
// unless IMP_HOST_TESTS=required: `bun run test:host`.

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
