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
