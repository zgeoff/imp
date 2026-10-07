import { readFileSync } from 'node:fs';
import { faker } from '@faker-js/faker';

// How many ports below the kernel's ephemeral range a test picks from
const PICK_SPAN = 4000;

// The first port the kernel hands out on its own, to a bind to port 0 or an
// outgoing connection. Ports below it are taken only by an explicit bind.
function readEphemeralStart(): number {
  const range = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8');

  return Number(range.trim().split(/\s+/)[0]);
}

// a listener on `port`, or null when something holds it
function openPortProbe(port: number) {
  try {
    return Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => {} } });
  } catch {
    return null;
  }
}

// `count` free ports from just below the ephemeral range, held open together
// so they differ; take them in turn. In that range, no port-0 bind elsewhere
// can take one between this probe and the test's own bind. The seeded faker picks.
export function findFreePorts(count: number) {
  const top = readEphemeralStart();
  const probes: NonNullable<ReturnType<typeof openPortProbe>>[] = [];

  while (probes.length < count) {
    const probe = openPortProbe(faker.number.int({ min: top - PICK_SPAN, max: top - 1 }));

    if (probe !== null) {
      probes.push(probe);
    }
  }

  const ports = probes.map((probe) => probe.port);

  for (const probe of probes) {
    probe.stop(true);
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
