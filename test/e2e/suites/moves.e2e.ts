import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeUpstream } from '../lib/fake-upstream';
import type { FakeUpstream } from '../lib/fake-upstream';
import { resolveImageName } from '../lib/fixtures';
import type { ImpRunOptions } from '../lib/imp-cli';
import {
  assertState,
  findImp,
  readImpEnv,
  requireImp,
  runImp,
  runImpWith,
  tryImp,
} from '../lib/imp-cli';
import { createImp, holdImp, writeGuestFile } from '../lib/imps';
import type { DevInstance } from '../lib/instance';
import { runInContainer } from '../lib/instance';
import { HOST_B, startMoveHosts, stopMoveHosts } from '../lib/move-hosts';
import type { MoveHosts } from '../lib/move-hosts';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// Moves between A and B on a Docker network (lib/move-hosts.ts), allowed
// off the tailnet by IMP_MOVE_TEST_CIDR; moves-tailnet covers the real
// peer check.

const prefix = setupSuite('moves');
const TINY = resolveImageName('e2e-tiny');
const BASE = resolveImageName('base');
const cold = `${prefix}cold`;
const kept = `${prefix}kept`;
const open = `${prefix}open`;
const box = `${prefix}box`;
const secret = `${prefix}gh`;

// each host's broker holds its own token for the secret, so the upstream
// tells which broker sent a call
const tokens = { a: `e2e-a-${randomUUID()}`, b: `e2e-b-${randomUUID()}` };
let hosts: MoveHosts;
let upstream: FakeUpstream;

function onB(): ImpRunOptions {
  return { target: hosts.b };
}

function runOnB(...args: readonly string[]): Promise<string> {
  return runImpWith(onB(), ...args);
}

function runShellOnB(name: string, script: string): Promise<string> {
  return runOnB('exec', name, '--', 'sh', '-c', script).then((out) => out.replace(/\n$/, ''));
}

// `imp move` from A to B, as a user with both saved runs it
function runMoveToB(name: string, ...args: readonly string[]): Promise<string> {
  return runImpWith({ env: hosts.cliEnv }, 'move', name, HOST_B, ...args);
}

function writeUpstreamsFile(target: DevInstance): void {
  writeFileSync(
    join(target.dataDir, 'broker-test-upstreams.json'),
    JSON.stringify({
      ca: upstream.caPem,
      upstreams: { 'github.com': upstream.origin, 'api.github.com': upstream.origin },
    }),
  );
}

// the fake upstream checks one token; B's broker must send B's
async function createSecrets(): Promise<void> {
  await tryImp(['secret', 'rm', secret]);
  await tryImp(['secret', 'rm', secret], onB());
  await runImpWith({ stdin: `${tokens.a}\n` }, 'secret', 'add', secret, '--kind', 'github');

  await runImpWith(
    { ...onB(), stdin: `${tokens.b}\n` },
    'secret',
    'add',
    secret,
    '--kind',
    'github',
  );
}

beforeAll(async () => {
  hosts = await startMoveHosts({ tailnet: false }, prefix);
  upstream = await startFakeUpstream(hosts.gateway, tokens.b);

  writeUpstreamsFile(hosts.a);
  writeUpstreamsFile(hosts.b);

  await createSecrets();
}, 1_800_000);

afterAll(async () => {
  for (const name of [cold, kept, open, box]) {
    await tryImp(['rm', name], onB());
  }

  await tryImp(['secret', 'rm', secret]);

  await upstream[Symbol.asyncDispose]();

  rmSync(join(hosts.a.dataDir, 'broker-test-upstreams.json'), { force: true });
  rmSync(join(hosts.b.dataDir, 'broker-test-upstreams.json'), { force: true });

  await stopMoveHosts(hosts);
}, 900_000);

test('a stopped imp moves cold with its disk and checkpoint, and boots on the target', async () => {
  await createImp(cold, '--image', TINY, '--memory', '256');
  await writeGuestFile(cold, '/root/moved', 'cold-ok');
  await runImp('checkpoint', cold, 'mv1');
  await runImp('stop', cold);

  const out = await runMoveToB(cold);
  const left = await findImp(cold);

  expect(out).toContain(`${cold}: moved to ${HOST_B}`);
  expect(left).toBeUndefined();

  const row = await requireImp(cold, hosts.b);
  const checkpoints = await runOnB('checkpoints', cold, '--json');

  expect(row.state).toBe('stopped');
  expect(checkpoints).toContain('"mv1"');

  await runOnB('start', cold);

  const content = await waitFor(`${cold} to boot on B`, () => runShellOnB(cold, 'cat /root/moved'));

  expect(content).toBe('cold-ok');

  // room for the warm moves' guests in B's budget
  await runOnB('rm', cold);
});

test('an abort after the source marked the imp leaves it where it was', async () => {
  await createImp(kept, '--image', TINY, '--memory', '256');
  await runImp('stop', kept);

  // the first step of a move, then the end a user picks
  const env = await readImpEnv();

  const prepared = await fetch(`${hosts.a.apiUrl}/rpc/moves/prepare`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env['IMP_TOKEN'] ?? ''}`,
    },
    body: JSON.stringify({ json: { name: kept, targetStorage: 'xfs' } }),
  });

  expect(prepared.status).toBe(200);

  const out = await runMoveToB(kept, '--abort');
  const onTarget = await findImp(kept, hosts.b);

  expect(out).toContain('move aborted; it stays here');
  expect(onTarget).toBeUndefined();

  await runImp('start', kept);
  await waitFor(`${kept} to boot on A`, () => assertState(kept, 'running'));
  await runImp('rm', kept);
});

// a mark in tmpfs and a process that only memory holds: both survive a
// warm move, and a cold boot loses them
const MARK_SCRIPT = 'echo warm-ok > /dev/shm/mark && (sleep 100000 >/dev/null 2>&1 &) && sync';

async function readSleeperPid(run: (script: string) => Promise<string>): Promise<string> {
  const pid = await run(`pgrep -f 'sleep 100000' || true`);

  return pid.split('\n')[0] ?? '';
}

// the IPv4 addresses a box slot's set lets in, on A unless `target` says
async function readAllowSet(slot: number, target?: DevInstance): Promise<string[]> {
  const listed = await runInContainer(
    ['nft', 'list', 'set', 'inet', 'imp_egress', `allow${String(slot)}`],
    target,
  );

  const elements = /elements = \{(?<list>[^\}]*)\}/v.exec(listed.stdout)?.groups?.['list'] ?? '';

  return [...elements.matchAll(/\d+\.\d+\.\d+\.\d+/gv)].map((match) => match[0]);
}

// On B: the uid the imp's Firecracker runs as, and the owners of its disk
// and its tap. The wake's jail prepare gives the disk to that uid.
async function readJailOwnersOnB(id: string, slot: number): Promise<string[]> {
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
    hosts.b,
  );

  return result.stdout.trim().split('\n');
}

// sleeps the imp on A and moves it warm; the CLI's line names it
async function runWarmMove(name: string): Promise<void> {
  await runImp('hold', name, '0');
  await runImp('sleep', name);
  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'));

  const out = await runMoveToB(name);
  const left = await findImp(name);
  const moved = await requireImp(name, hosts.b);

  expect(out).toContain(`${name}: moved to ${HOST_B}, asleep with its memory`);
  expect(left).toBeUndefined();
  expect(moved.state).toBe('sleeping');
}

// A warm move keeps the imp's slot, so the two warm imps live on A side by
// side: the second gets a slot the first does not take on B
test('two imps for the warm moves boot on A in slots of their own', async () => {
  await createImp(open, '--image', TINY, '--memory', '256');

  await createImp(
    box,
    '--image',
    BASE,
    '--memory',
    '1g',
    '--policy',
    'box',
    '--allow',

    // B resolves only the exact names at create: a wildcard's addresses on
    // B can only have come from A's lookups
    'example.com,api.github.com,github.com,*.wikipedia.org',
  );

  const slots = await Promise.all([requireImp(open), requireImp(box)]);

  expect(slots[0].slot).not.toBe(slots[1].slot);
});

test('a sleeping open imp moves with its memory and reaches out at once on the target', async () => {
  await holdImp(open);
  await runImp('exec', open, '--', 'sh', '-c', MARK_SCRIPT);

  const pid = await readSleeperPid((script) => runImp('exec', open, '--', 'sh', '-c', script));

  expect(pid).not.toBe('');

  await runWarmMove(open);

  // the first exec wakes it on B
  const mark = await runShellOnB(open, 'cat /dev/shm/mark');
  const after = await readSleeperPid((script) => runShellOnB(open, script));
  const lookup = await runShellOnB(open, 'nslookup example.com >/dev/null && echo dns-ok');

  const fetched = await runShellOnB(
    open,
    'wget -q -T 10 -O /dev/null http://example.com/ && echo http-ok',
  );

  const row = await requireImp(open, hosts.b);
  const owners = await readJailOwnersOnB(row.id, row.slot);

  const uid = owners[0] ?? '';

  expect(mark).toBe('warm-ok');
  expect(after).toBe(pid);
  expect(lookup).toBe('dns-ok');
  expect(fetched).toBe('http-ok');
  expect(row.coldBootReason).toBeUndefined();
  expect(Number(uid)).toBeGreaterThanOrEqual(900_000);
  expect(owners).toEqual([uid, uid, uid]);
});

test('a sleeping box imp keeps its list, and the target’s broker answers right after the wake', async () => {
  await runImp('grant', box, secret);
  await holdImp(box);
  await runImp('exec', box, '--', 'sh', '-c', MARK_SCRIPT);

  const pid = await readSleeperPid((script) => runImp('exec', box, '--', 'sh', '-c', script));

  // a lookup on A under the wildcard, whose answer only the move can carry
  // into B's set for the slot
  await runImp('exec', box, '--', 'getent', 'hosts', 'en.wikipedia.org');

  const onA = await requireImp(box);
  const before = await readAllowSet(onA.slot);

  await runWarmMove(box);

  // read before the guest can look anything up again on B
  const held = await readAllowSet(onA.slot, hosts.b);

  // the broker call first: the target installs its CA at the first wake
  const body = await runShellOnB(box, 'curl -sS --fail https://api.github.com/user');
  const mark = await runShellOnB(box, 'cat /dev/shm/mark');
  const after = await readSleeperPid((script) => runShellOnB(box, script));

  const allowed = await runShellOnB(
    box,
    'curl -sS -o /dev/null -w "%{http_code}" --max-time 10 http://example.com/',
  );

  const refused = await runShellOnB(
    box,
    'curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://example.org/ || true',
  );

  expect(before.length).toBeGreaterThan(0);
  expect(before.filter((address) => !held.includes(address))).toEqual([]);
  expect(JSON.parse(body)).toEqual({ authorized: true });
  expect(upstream.seen.at(-1)?.authorization).toBe(`Bearer ${tokens.b}`);
  expect(mark).toBe('warm-ok');
  expect(after).toBe(pid);
  expect(allowed).toBe('200');
  expect(refused).toBe('000');
});
