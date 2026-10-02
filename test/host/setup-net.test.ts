import { expect, test } from 'bun:test';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', '..', 'host', 'scripts', 'setup-net.sh');

// setup-net.sh runs as root in a fresh user and network namespace, with a
// dummy uplink. Skipped where unprivileged namespaces or iptables are off
// (Ubuntu 24.04 runners restrict them).
const canUnshare =
  Bun.spawnSync(['unshare', '-rn', 'iptables', '-t', 'raw', '-S'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

function runInNetns(script: string) {
  const result = Bun.spawnSync(['unshare', '-rn', 'bash', '-euo', 'pipefail', '-c', script], {
    env: { ...process.env, SETUP_NET: SCRIPT, BUN: process.execPath },
  });

  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);

  return result.stdout.toString();
}

const UPLINK = `
ip link add up0 type dummy
ip link set up0 up
ip addr add 192.0.2.2/24 dev up0
ip route add default via 192.0.2.1
`;

test.skipIf(!canUnshare)(
  'a port change and an older INPUT drop leave one pair of broker rules',
  () => {
    const rules = runInNetns(`${UPLINK}
IMP_BROKER_PORT=7099 bash "$SETUP_NET" >/dev/null
iptables -A INPUT ! -i imp+ -p tcp --dport 7081 -m comment --comment imp-broker -j DROP
bash "$SETUP_NET" >/dev/null
bash "$SETUP_NET" >/dev/null
iptables -S INPUT | grep imp-broker
iptables -t raw -S PREROUTING | grep imp-broker
`);

    expect(rules.trim().split('\n')).toEqual([
      '-A INPUT -i imp+ -p tcp -m tcp --dport 7081 -m comment --comment imp-broker -j ACCEPT',
      '-A PREROUTING ! -i imp+ -p tcp -m tcp --dport 7081 -m addrtype --dst-type LOCAL -m comment --comment imp-broker -j DROP',
    ]);
  },
);

test.skipIf(!canUnshare)('the broker port drops a connection from outside the taps', () => {
  // lo stands in for eth0 and tailscale0: anything that is not imp+. The
  // first INPUT rule accepts it all, as tailscaled's ts-input does later.
  const reached = runInNetns(`${UPLINK}
ip link set lo up
bash "$SETUP_NET" >/dev/null
iptables -I INPUT 1 -j ACCEPT
"$BUN" -e 'for (const port of [7081, 7082]) Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } })' &
sleep 0.5
for port in 7081 7082; do
  if timeout 1 bash -c "exec 3<>/dev/tcp/192.0.2.2/$port" 2>/dev/null; then echo "$port open"; else echo "$port dropped"; fi
done
kill $!
`);

  expect(reached.trim().split('\n')).toEqual(['7081 dropped', '7082 open']);
});

test.skipIf(!canUnshare)(
  'a resolver port change leaves one UDP and one TCP pair of egress DNS rules',
  () => {
    const rules = runInNetns(`${UPLINK}
IMP_EGRESS_DNS_PORT=7099 bash "$SETUP_NET" >/dev/null
bash "$SETUP_NET" >/dev/null
bash "$SETUP_NET" >/dev/null
iptables -S INPUT | grep imp-egress-dns
iptables -t raw -S PREROUTING | grep imp-egress-dns
`);

    expect(rules.trim().split('\n')).toEqual([
      '-A INPUT -i imp+ -p tcp -m tcp --dport 7053 -m comment --comment imp-egress-dns -j ACCEPT',
      '-A INPUT -i imp+ -p udp -m udp --dport 7053 -m comment --comment imp-egress-dns -j ACCEPT',
      '-A PREROUTING ! -i imp+ -p udp -m udp --dport 7053 -m addrtype --dst-type LOCAL -m comment --comment imp-egress-dns -j DROP',
      '-A PREROUTING ! -i imp+ -p tcp -m tcp --dport 7053 -m addrtype --dst-type LOCAL -m comment --comment imp-egress-dns -j DROP',
    ]);
  },
);

test.skipIf(!canUnshare)(
  'with an IPv6 uplink, guests get NDP to the host, forwarding out and nothing unasked in',
  () => {
    const out = runInNetns(`${UPLINK}
ip -6 addr add 2001:db8:a::2/64 dev up0 nodad
ip -6 route add default via 2001:db8:a::1
IMP_UPLINK_MTU=1280 bash "$SETUP_NET" >/dev/null
IMP_UPLINK_MTU=1280 bash "$SETUP_NET" >/dev/null
ip6tables -S INPUT | grep imp+
ip6tables -S FORWARD | grep imp+
ip6tables -t raw -S PREROUTING | grep imp+
ip6tables -t mangle -S FORWARD | grep imp+
sysctl -n net.ipv6.conf.up0.accept_ra net.ipv6.conf.default.accept_ra net.ipv6.conf.default.accept_redirects net.ipv6.conf.all.forwarding
`);

    expect(out.trim().split('\n')).toEqual([
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
    ]);
  },
);
