import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { runImpWith } from './imp-cli';
import type { DevInstance } from './instance';
import { readToken, runInContainer } from './instance';
import { HOST_B } from './move-hosts';
import type { MoveHosts } from './move-hosts';
import type { StubUpstream } from './start-stub-upstream';

// A's saved name beside B's, for the commands that reach every saved host
export const HOST_A = 'a';

export interface RpcAnswer {
  readonly ok: boolean;
  readonly body: unknown;
}

const LeaseSchema = z.object({
  owner: z.object({ principal: z.string(), label: z.string() }),
  until: z.iso.datetime().nullable(),
});

export type MoveLease = z.infer<typeof LeaseSchema>;

const HostImpSchema = z.object({ host: z.string(), name: z.string(), move: z.string().optional() });
const HostImpsSchema = z.object({ imps: z.array(HostImpSchema) });

export interface HostListing {
  // the table's rows for the name, one per host that holds it
  readonly rows: readonly string[];
  readonly imps: readonly z.infer<typeof HostImpSchema>[];
}

// a host's API answer: its `json`, which holds the error when it failed
export function parseRpcAnswer(ok: boolean, raw: unknown): RpcAnswer {
  return { ok, body: z.object({ json: z.unknown() }).parse(raw).json };
}

// `impz ls --all` and `impz ls --all --json`, cut to the rows that name `name`
export function parseHostListing(table: string, json: string, name: string): HostListing {
  const rows = table
    .trimEnd()
    .split('\n')
    .filter((row) => row.split(/\s+/v)[1] === name);

  const body = HostImpsSchema.parse(JSON.parse(json));

  return { rows, imps: body.imps.filter((imp) => imp.name === name) };
}

// the IPv4 addresses in `nft list set` output
export function parseNftSetAddresses(listed: string): readonly string[] {
  const elements = /elements = \{(?<list>[^\}]*)\}/v.exec(listed)?.groups?.['list'] ?? '';

  return [...elements.matchAll(/\d+\.\d+\.\d+\.\d+/gv)].map((match) => match[0]);
}

// a call to a host's API as its root token
export async function sendHostRpc(
  target: DevInstance,
  path: string,
  input: unknown,
): Promise<RpcAnswer> {
  const token = await readToken(target);

  const response = await fetch(`${target.apiUrl}/rpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(60_000),
  });

  const raw: unknown = await response.json();

  return parseRpcAnswer(response.ok, raw);
}

export async function listLeasesOn(target: DevInstance, name: string): Promise<MoveLease[]> {
  const answer = await sendHostRpc(target, 'leases/list', { name });

  return z.array(LeaseSchema).parse(answer.body);
}

// The first step of a move, as the source's own route: it marks the imp
// `sending` and goes no further.
export async function startMoveSend(target: DevInstance, name: string): Promise<void> {
  const answer = await sendHostRpc(target, 'moves/prepare', { name, targetStorage: 'xfs' });

  if (!answer.ok) {
    throw new Error(`moves/prepare for ${name} failed: ${JSON.stringify(answer.body)}`);
  }
}

// both hosts saved in a CLI config at `dir`, so the move config keeps B alone
export async function writeBothHostsConfig(
  hosts: Readonly<MoveHosts>,
  dir: string,
): Promise<Record<string, string>> {
  const env = { XDG_CONFIG_HOME: dir };

  const tokenA = await readToken(hosts.a);

  await runImpWith({ stdin: `${tokenA}\n`, env }, 'login', hosts.a.apiUrl, '--name', HOST_A);

  const tokenB = await readToken(hosts.b);

  await runImpWith({ stdin: `${tokenB}\n`, env }, 'login', hosts.b.apiUrl, '--name', HOST_B);

  return env;
}

export async function listAllHosts(
  env: Readonly<Record<string, string>>,
  name: string,
): Promise<HostListing> {
  const table = await runImpWith({ env }, 'ls', '--all');
  const json = await runImpWith({ env }, 'ls', '--all', '--json');

  return parseHostListing(table, json, name);
}

// where broker/test-upstreams.ts reads a host's upstreams from
export function buildUpstreamsPath(target: DevInstance): string {
  return join(target.dataDir, 'broker-test-upstreams.json');
}

// points the host's broker at the stub for github.com and api.github.com
export async function writeUpstreamsFile(
  target: DevInstance,
  upstream: Readonly<StubUpstream>,
): Promise<void> {
  await writeFile(
    buildUpstreamsPath(target),
    JSON.stringify({
      ca: upstream.caPem,
      upstreams: { 'github.com': upstream.origin, 'api.github.com': upstream.origin },
    }),
  );
}

// the IPv4 addresses a box slot's nft set lets in
export async function readAllowSet(target: DevInstance, slot: number): Promise<readonly string[]> {
  const listed = await runInContainer(
    ['nft', 'list', 'set', 'inet', 'imp_egress', `allow${String(slot)}`],
    target,
  );

  return parseNftSetAddresses(listed.stdout);
}

// The uid the imp's Firecracker runs as, then the owners of its disk and its
// tap: the wake's jail prepare gives the disk to that uid.
export async function readJailOwners(
  target: DevInstance,
  id: string,
  slot: number,
): Promise<readonly string[]> {
  const dir = `/var/lib/imp/imps/${id}`;

  const result = await runInContainer(
    [
      'sh',
      '-c',
      `pid=$(pgrep -f 'firecracker.*imps/${id}/' | head -n 1)
      disk=$(ls ${dir}/disk.ext4 ${dir}/disk/rootfs.ext4 2>/dev/null | head -n 1)
      stat -c %u "/proc/$pid" "$disk"
      cat /sys/class/net/imp${String(slot)}/owner`,
    ],
    target,
  );

  return result.stdout.trim().split('\n');
}
