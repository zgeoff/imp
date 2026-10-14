import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { runImp } from './imp-cli';
import { instance } from './instance';

// The broker's test upstreams (IMP_BROKER_TEST_UPSTREAMS, as scripts/dev/dev.sh
// sets it): the hosts a journey's stub upstream stands in for.

export interface BrokerUpstreams {
  readonly ca: string;
  readonly upstreams: Readonly<Record<string, string>>;
}

// every host to the stub's origin, trusting the stub's CA
export function buildBrokerUpstreams(
  caPem: string,
  origin: string,
  hosts: readonly string[],
): BrokerUpstreams {
  return { ca: caPem, upstreams: Object.fromEntries(hosts.map((host) => [host, origin])) };
}

// The gateway of the imp in the slot: its /30's first address in 10.66/16.
export function buildSlotGateway(slot: number): string {
  return `10.66.${String(Math.floor((slot * 4) / 256))}.${String(((slot * 4) % 256) + 1)}`;
}

const BrokerAuditSchema = z.array(
  z.object({
    // null, as the secret is, on a request the broker refused
    host: z.string().nullable(),
    path: z.string().nullable(),
    status: z.number(),
    secret: z.string().nullable(),
    requestBytes: z.number(),
    reason: z.string().nullable(),
  }),
);

// Thin glue over the dev instance below.

function readUpstreamsPath(): string {
  return join(instance.dataDir, 'broker-test-upstreams.json');
}

// the caller removes it with removeBrokerUpstreams
export async function writeBrokerUpstreams(upstreams: Readonly<BrokerUpstreams>): Promise<void> {
  await writeFile(readUpstreamsPath(), JSON.stringify(upstreams));
}

export async function removeBrokerUpstreams(): Promise<void> {
  await rm(readUpstreamsPath(), { force: true });
}

// the broker's requests for the imp, sent and refused, as `imp audit` lists them
export async function readBrokerAudit(name: string) {
  const stdout = await runImp('audit', name, '--json');

  return BrokerAuditSchema.parse(JSON.parse(stdout));
}
