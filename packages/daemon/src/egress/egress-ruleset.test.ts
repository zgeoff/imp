import { expect, test } from 'bun:test';
import { buildMockFirewallSlot } from '../test-utils/build-mock-firewall-slot';
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

  expect([script.includes('public4'), script.includes('uplinks')]).toStrictEqual([false, false]);
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
