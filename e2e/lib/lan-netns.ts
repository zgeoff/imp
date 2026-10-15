import { runImp } from './imp-cli';
import { runInContainer } from './instance';
import { waitFor } from './wait-for';

// A netns in the dev container behind a veth: a 10/8 and a link-local
// address, whose listener logs each connection. Guests reach it through
// FORWARD, as a private network beside the host.
export const LAN = {
  netns: 'e2e-egress-lan',
  private: '10.250.77.1',
  linkLocal: '169.254.77.1',
  port: 8077,
  log: '/tmp/e2e-egress-lan.log',
} as const;

// the connections the log shows to each address, 0 for one it lacks
export function countLanConnections(
  log: string,
  addresses: readonly string[],
): Readonly<Record<string, number>> {
  const locals = log.split('\n').map((line) => line.split(' ')[0] ?? '');

  return Object.fromEntries(
    addresses.map((address) => [address, locals.filter((local) => local === address).length]),
  );
}

export interface Dial {
  readonly isConnected: boolean;
  readonly ms: number;
  readonly error: string;
}

// `<nc exit code> <ms> <wget's error>`, as runTimedDial's script prints it
export function parseTimedDial(out: string): Dial {
  const [rc = '', ms = '', ...words] = out.trim().split(' ');

  return { isConnected: rc === '0', ms: Number(ms), error: words.join(' ') };
}

// Thin glue over the host container and live guests below.

const LAN_LISTENER = `
const { appendFileSync } = require('node:fs');
Bun.listen({
  hostname: '0.0.0.0',
  port: ${String(LAN.port)},
  socket: {
    open: (socket) => {
      appendFileSync('${LAN.log}', socket.localAddress + ' ' + socket.remoteAddress + '\\n');
      socket.write('hello\\n');
    },
    data: () => {},
  },
});
`;

const LAN_SETUP = `
set -e
ip netns del ${LAN.netns} 2>/dev/null || true
ip link del e2elan0 2>/dev/null || true
ip netns add ${LAN.netns}
ip link add e2elan0 type veth peer name eth0 netns ${LAN.netns}
ip addr add 10.250.77.254/24 dev e2elan0
ip link set e2elan0 up
ip -n ${LAN.netns} addr add ${LAN.private}/24 dev eth0
ip -n ${LAN.netns} addr add ${LAN.linkLocal}/32 dev eth0
ip -n ${LAN.netns} link set eth0 up
ip -n ${LAN.netns} link set lo up
ip -n ${LAN.netns} route add default via 10.250.77.254
ip route add ${LAN.linkLocal}/32 dev e2elan0
: > ${LAN.log}
setsid ip netns exec ${LAN.netns} bun -e "$LISTENER" </dev/null >/dev/null 2>&1 &
`;

// Starts the netns and its listener, and returns once the container reaches
// both addresses; the caller stops it with stopLanNetns.
export async function startLanNetns(): Promise<void> {
  const result = await runInContainer(['env', `LISTENER=${LAN_LISTENER}`, 'sh', '-c', LAN_SETUP]);

  if (result.exitCode !== 0) {
    throw new Error(`the lan netns: ${result.stderr}`);
  }

  await waitFor('the lan listeners', async () => {
    const probes = await Promise.all(
      [LAN.private, LAN.linkLocal].map((address) =>
        runInContainer(['bash', '-c', `exec 3<>/dev/tcp/${address}/${String(LAN.port)}`]),
      ),
    );

    if (probes.some((probe) => probe.exitCode !== 0)) {
      throw new Error('a lan listener is not up yet');
    }
  });
}

// removing the netns removes its veth and the route through it
export async function stopLanNetns(): Promise<void> {
  await runInContainer([
    'sh',
    '-c',
    `ip netns pids ${LAN.netns} | xargs -r kill; ip netns del ${LAN.netns}; rm -f ${LAN.log}`,
  ]);
}

export async function readLanConnections(): Promise<Readonly<Record<string, number>>> {
  const result = await runInContainer(['cat', LAN.log]);

  return countLanConnections(result.stdout, [LAN.private, LAN.linkLocal]);
}

// A TCP connection from the guest by nc, timed by /proc/uptime's hundredths;
// a failure is tried again with wget, which names it (nc fails in silence).
// A refusal is a reset, at once, where a drop takes all 5 s of -w.
export async function runTimedDial(name: string, target: string, port: number): Promise<Dial> {
  const script = [
    'rm -f /tmp/dial-err',
    "s=$(cut -d ' ' -f 1 /proc/uptime | tr -d .)",
    `echo | nc -w 5 ${target} ${String(port)} >/dev/null 2>&1`,
    'rc=$?',
    "e=$(cut -d ' ' -f 1 /proc/uptime | tr -d .)",
    `[ $rc = 0 ] || wget -q -T 5 -O /dev/null http://${target}:${String(port)}/ 2>/tmp/dial-err`,
    String.raw`echo "$rc $(( (e - s) * 10 )) $(head -c 200 /tmp/dial-err | tr -s "\n" " ")"`,
  ].join('; ');

  const out = await runImp('exec', name, '--', 'sh', '-c', script);

  return parseTimedDial(out);
}
