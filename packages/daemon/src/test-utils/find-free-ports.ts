import { onTestFinished } from 'bun:test';
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';

// How many ports below the kernel's ephemeral range a test picks from
const PICK_SPAN = 4000;

// The socket tables of this network namespace, for every family a test binds
const SOCKET_TABLES = ['tcp', 'tcp6', 'udp', 'udp6'].map((name) => `/proc/net/${name}`);

// The first port the kernel hands out on its own, to a bind to port 0 or an
// outgoing connection. Ports below it are taken only by an explicit bind.
function readEphemeralStart(): number {
  const range = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8');

  return Number(range.trim().split(/\s+/)[0]);
}

// Every local port a TCP or UDP socket of any state holds, on any address
function readBusyPorts(): ReadonlySet<number> {
  const busy = new Set<number>();

  for (const table of SOCKET_TABLES) {
    // the header line, then one socket per line: `sl local_address ...`,
    // where local_address is `<hex address>:<hex port>`
    const lines = readFileSync(table, 'utf8').trim().split('\n');

    for (const line of lines.slice(1)) {
      const local = line.trim().split(/\s+/)[1] ?? '';
      const hexPort = local.slice(local.lastIndexOf(':') + 1);

      busy.add(Number.parseInt(hexPort, 16));
    }
  }

  return busy;
}

// A claim on `port` that every picker in every process on this host sees: an
// abstract unix socket, which only one holder can bind and which the kernel
// frees when its process dies. Null when another picker holds it.
function claimPort(port: number) {
  try {
    return Bun.listen({ unix: `\0imp-test-port-${String(port)}`, socket: { data: () => {} } });
  } catch {
    return null;
  }
}

interface FindFreePortsOptions {
  // the next port to try; a random one from just below the ephemeral range by default
  readonly pick?: () => number;
}

// `count` distinct free ports from just below the ephemeral range, claimed
// until the test ends so no picker in another process hands one out again. A
// process that binds such a port without a claim can still race the test.
export function findFreePorts(count: number, options: FindFreePortsOptions = {}) {
  const top = readEphemeralStart();
  const pick = options.pick ?? (() => randomInt(top - PICK_SPAN, top));
  const claims: NonNullable<ReturnType<typeof claimPort>>[] = [];
  const ports: number[] = [];

  onTestFinished(() => {
    for (const claim of claims) {
      claim.stop(true);
    }
  });

  while (ports.length < count) {
    const port = pick();
    const claim = claimPort(port);

    if (claim === null) {
      continue;
    }

    claims.push(claim);

    if (!readBusyPorts().has(port)) {
      ports.push(port);
    }
  }

  return {
    take: (): number => {
      const port = ports.shift();

      if (port === undefined) {
        throw new Error(`only ${String(count)} free ports were asked for`);
      }

      return port;
    },
  };
}
