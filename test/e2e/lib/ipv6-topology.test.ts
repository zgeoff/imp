import { expect, test } from 'bun:test';
import {
  buildGuestIpv6,
  buildRaCounterRuleset,
  buildV6Names,
  buildV6Plan,
  parseGlobal128,
  parseRaCounts,
  parseRouteDevice,
  parseRsAccepts,
  parseUlaNetwork,
} from './ipv6-topology';

test('#buildV6Plan gives offset 0 the 6a, 6b and 6c /64s', () => {
  expect(buildV6Plan(0)).toStrictEqual({
    near: '2001:db8:6a::',
    far: '2001:db8:6b::',
    routed: '2001:db8:6c::',
    routerNear: '2001:db8:6a::100',
    routerFar: '2001:db8:6b::100',
    server: '2001:db8:6b::200',
    serverOther: '2001:db8:6b::201',
  });
});

test('#buildV6Plan moves each offset three /64s on', () => {
  expect(buildV6Plan(700).near).toBe('2001:db8:89e::');
});

test('#buildGuestIpv6 puts the IPv4 address in the interface ID', () => {
  expect(buildGuestIpv6('fd12:3456:789a::', '10.66.0.6')).toBe('fd12:3456:789a::a42:6');
});

test('#buildGuestIpv6 writes each half of the IPv4 address as one group', () => {
  expect(buildGuestIpv6('2001:db8:6c::', '10.66.1.254')).toBe('2001:db8:6c::a42:1fe');
});

test('#buildV6Names names the networks and containers after the instance', () => {
  expect(buildV6Names('imp-e2e-a')).toStrictEqual({
    near: 'imp-e2e-a-v6',
    far: 'imp-e2e-a-v6far',
    router: 'imp-e2e-a-v6-router',
    server: 'imp-e2e-a-v6-server',
  });
});

test('#parseUlaNetwork reads the NAT66 prefix impd logged', () => {
  const log = 'impd: listening\nimpd: ipv6: fd4e:2a1b:9c00::/64, NAT66 behind 2001:db8:6a::2\n';

  expect(parseUlaNetwork(log)).toBe('fd4e:2a1b:9c00::');
});

test('#parseUlaNetwork throws on a log without the NAT66 prefix', () => {
  expect(() => parseUlaNetwork('impd: listening\n')).toThrowWithMessage(
    TypeError,
    'impd logged no NAT66 prefix:\nimpd: listening\n',
  );
});

test('#parseGlobal128 reads the global /128 of the guest', () => {
  const shown = [
    '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP qlen 1000',
    '    inet6 fd4e:2a1b:9c00::a42:6/128 scope global',
    '       valid_lft forever preferred_lft forever',
  ].join('\n');

  expect(parseGlobal128(shown)).toBe('fd4e:2a1b:9c00::a42:6');
});

test('#parseGlobal128 reads no global address as empty', () => {
  expect(parseGlobal128('2: eth0: <UP> mtu 1500\n')).toBe('');
});

test('#parseRsAccepts reads the packets the taps’ RS ACCEPT rule counted', () => {
  const listing = [
    'Chain INPUT (policy ACCEPT 0 packets, 0 bytes)',
    '    pkts      bytes target     prot opt in     out     source               destination',
    '       0        0 ACCEPT     ipv6-icmp --  imp+   *       ::/0                 ::/0                 ipv6-icmptype 136 HL match HL == 255',
    '       3      168 ACCEPT     ipv6-icmp --  imp+   *       ::/0                 ::/0                 ipv6-icmptype 133 HL match HL == 255',
    '       0        0 DROP       all  --  imp+   *       ::/0                 ::/0',
  ].join('\n');

  expect(parseRsAccepts(listing)).toBe(3);
});

test('#buildRaCounterRuleset counts the tap’s advertisements and solicitations on ingress', () => {
  expect(buildRaCounterRuleset('imp3')).toBe(
    [
      'table netdev e2e_ra {',
      '  chain ingress {',
      '    type filter hook ingress device "imp3" priority 0;',
      '    icmpv6 type nd-router-advert counter',
      '    icmpv6 type nd-router-solicit counter',
      '  }',
      '}',
    ].join('\n'),
  );
});

test('#parseRaCounts reads both counters of the table nft lists', () => {
  const listing = [
    'table netdev e2e_ra {',
    '\tchain ingress {',
    '\t\ttype filter hook ingress device "imp3" priority filter; policy accept;',
    '\t\ticmpv6 type nd-router-advert counter packets 3 bytes 264',
    '\t\ticmpv6 type nd-router-solicit counter packets 1 bytes 56',
    '\t}',
    '}',
  ].join('\n');

  expect(parseRaCounts(listing)).toStrictEqual({ adverts: 3, solicits: 1 });
});

test('#parseRouteDevice reads the device of a route', () => {
  expect(parseRouteDevice(String.raw`10.66.0.6 dev imp3 src 10.66.0.5 uid 0 \    cache`)).toBe(
    'imp3',
  );
});
