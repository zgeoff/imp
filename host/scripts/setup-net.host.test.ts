import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { canUnshare } from '../../packages/daemon/src/test-utils/can-unshare';
import { runInNetns } from '../../packages/daemon/src/test-utils/run-in-netns';

// setup-net.sh runs as root in a fresh network namespace, through a user
// namespace when not root, with a dummy uplink. Each test skips where that or
// a tool it runs is missing, unless IMP_HOST_TESTS=required: `bun run test:host`.

test.skipIf(
  !canUnshare([
    'sh',
    '-c',
    'iptables -t raw -S && ip6tables -t raw -S && ip link && command -v sysctl',
  ]),
)('it leaves one pair of broker rules after a port change and an older INPUT drop', () => {
  const run = runInNetns({
    script: `
ip link add up0 type dummy
ip link set up0 up
ip addr add 192.0.2.2/24 dev up0
ip route add default via 192.0.2.1
IMP_BROKER_PORT=7099 bash "$SETUP_NET" >/dev/null
iptables -A INPUT ! -i imp+ -p tcp --dport 7081 -m comment --comment imp-broker -j DROP
bash "$SETUP_NET" >/dev/null
bash "$SETUP_NET" >/dev/null
iptables -S INPUT | grep imp-broker
iptables -t raw -S PREROUTING | grep imp-broker
`,
    env: { SETUP_NET: join(import.meta.dir, 'setup-net.sh') },
    mount: false,
  });

  expect(run).toStrictEqual({
    stdout: [
      '-A INPUT -i imp+ -p tcp -m tcp --dport 7081 -m comment --comment imp-broker -j ACCEPT',
      '-A PREROUTING ! -i imp+ -p tcp -m tcp --dport 7081 -m addrtype --dst-type LOCAL -m comment --comment imp-broker -j DROP',
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
    'iptables -t raw -S && ip6tables -t raw -S && ip link && command -v sysctl',
  ]),
)('it drops a connection to the broker port from outside the taps', () => {
  // lo stands in for eth0 and tailscale0: anything that is not imp+. The
  // first INPUT rule accepts it all, as tailscaled's ts-input does later.
  // The listener says when both ports are bound, and the probes wait on it.
  const run = runInNetns({
    script: `
ip link add up0 type dummy
ip link set up0 up
ip addr add 192.0.2.2/24 dev up0
ip route add default via 192.0.2.1
ip link set lo up
bash "$SETUP_NET" >/dev/null
iptables -I INPUT 1 -j ACCEPT
coproc LISTENER { exec "$BUN" -e 'for (const port of [7081, 7082]) Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }); console.log("listening")'; }
read -r _ <&"\${LISTENER[0]}"
for port in 7081 7082; do
  if timeout 1 bash -c "exec 3<>/dev/tcp/192.0.2.2/$port" 2>/dev/null; then echo "$port open"; else echo "$port dropped"; fi
done
kill "$LISTENER_PID"
`,
    env: { SETUP_NET: join(import.meta.dir, 'setup-net.sh'), BUN: process.execPath },
    mount: false,
  });

  expect(run).toStrictEqual({ stdout: '7081 dropped\n7082 open\n', stderr: '', exitCode: 0 });
});

test.skipIf(
  !canUnshare([
    'sh',
    '-c',
    'iptables -t raw -S && ip6tables -t raw -S && ip link && command -v sysctl',
  ]),
)('it leaves one UDP and one TCP pair of egress DNS rules after a resolver port change', () => {
  const run = runInNetns({
    script: `
ip link add up0 type dummy
ip link set up0 up
ip addr add 192.0.2.2/24 dev up0
ip route add default via 192.0.2.1
IMP_EGRESS_DNS_PORT=7099 bash "$SETUP_NET" >/dev/null
bash "$SETUP_NET" >/dev/null
bash "$SETUP_NET" >/dev/null
iptables -S INPUT | grep imp-egress-dns
iptables -t raw -S PREROUTING | grep imp-egress-dns
`,
    env: { SETUP_NET: join(import.meta.dir, 'setup-net.sh') },
    mount: false,
  });

  expect(run).toStrictEqual({
    stdout: [
      '-A INPUT -i imp+ -p tcp -m tcp --dport 7053 -m comment --comment imp-egress-dns -j ACCEPT',
      '-A INPUT -i imp+ -p udp -m udp --dport 7053 -m comment --comment imp-egress-dns -j ACCEPT',
      '-A PREROUTING ! -i imp+ -p udp -m udp --dport 7053 -m addrtype --dst-type LOCAL -m comment --comment imp-egress-dns -j DROP',
      '-A PREROUTING ! -i imp+ -p tcp -m tcp --dport 7053 -m addrtype --dst-type LOCAL -m comment --comment imp-egress-dns -j DROP',
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
    'iptables -t raw -S && ip6tables -t raw -S && ip link && command -v sysctl',
  ]),
)(
  'it writes the IPv6 guest rules, the MSS clamp and the forwarding sysctls once, with an IPv6 uplink',
  () => {
    const run = runInNetns({
      script: `
ip link add up0 type dummy
ip link set up0 up
ip addr add 192.0.2.2/24 dev up0
ip route add default via 192.0.2.1
ip -6 addr add 2001:db8:a::2/64 dev up0 nodad
ip -6 route add default via 2001:db8:a::1
IMP_UPLINK_MTU=1280 bash "$SETUP_NET" >/dev/null
IMP_UPLINK_MTU=1280 bash "$SETUP_NET" >/dev/null
ip6tables -S INPUT | grep imp+
ip6tables -S FORWARD | grep imp+
ip6tables -t raw -S PREROUTING | grep imp+
ip6tables -t mangle -S FORWARD | grep imp+
sysctl -n net.ipv6.conf.up0.accept_ra net.ipv6.conf.default.accept_ra net.ipv6.conf.default.accept_redirects net.ipv6.conf.all.forwarding
`,
      env: { SETUP_NET: join(import.meta.dir, 'setup-net.sh') },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout: [
        '-A INPUT -i imp+ -p ipv6-icmp -m icmp6 --icmpv6-type 136 -m hl --hl-eq 255 -j ACCEPT',
        '-A INPUT -i imp+ -p ipv6-icmp -m icmp6 --icmpv6-type 135 -m hl --hl-eq 255 -j ACCEPT',
        '-A INPUT -i imp+ -p ipv6-icmp -m icmp6 --icmpv6-type 133 -m hl --hl-eq 255 -j ACCEPT',
        '-A INPUT -i imp+ -j DROP',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '-A FORWARD -i imp+ -o up0 -j ACCEPT',
        '-A FORWARD -o imp+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
        '-A FORWARD -o imp+ -j DROP',
        '-A FORWARD -i imp+ -j DROP',
        '-A PREROUTING -i imp+ -m rpfilter --invert -j DROP',
        '-A FORWARD -i imp+ -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1220',
        '-A FORWARD -o imp+ -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1220',
        '2',
        '0',
        '0',
        '1',
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(
  !canUnshare([
    'sh',
    '-c',
    'iptables -t raw -S && ip6tables -t raw -S && ip link && command -v sysctl',
  ]),
)(
  'it replaces an older 0x2/0x2 network mark rule with the 0x1000000 one, ahead of the drop between taps',
  () => {
    const run = runInNetns({
      script: `
ip link add up0 type dummy
ip link set up0 up
ip addr add 192.0.2.2/24 dev up0
ip route add default via 192.0.2.1
iptables -A FORWARD -m mark --mark 0x2/0x2 -m comment --comment imp-network -j ACCEPT
bash "$SETUP_NET" >/dev/null
bash "$SETUP_NET" >/dev/null
iptables -S FORWARD | grep -- '-i imp+ -o imp+'
`,
      env: { SETUP_NET: join(import.meta.dir, 'setup-net.sh') },
      mount: false,
    });

    expect(run).toStrictEqual({
      stdout: [
        '-A FORWARD -i imp+ -o imp+ -m mark --mark 0x1000000/0x1000000 -m comment --comment imp-network -j ACCEPT',
        '-A FORWARD -i imp+ -o imp+ -j DROP',
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });
  },
);
