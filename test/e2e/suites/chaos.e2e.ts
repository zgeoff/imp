import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import type { ImpRow } from '../lib/imp-cli';
import { listImps, runImp, runInImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import {
  checkHealthReady,
  findImpdPid,
  instance,
  runChecked,
  runCommand,
  runDevScript,
  runInContainer,
} from '../lib/instance';
import type { MemoryProof } from '../lib/memory-proof';
import { checkMemoryKept, startMemoryProof } from '../lib/memory-proof';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// Random operations cut short by a kill of impd, a Firecracker or the
// container; every imp must stay valid, keep its disk, and keep its memory
// unless the round could take it. Three 512 MiB imps: guests under 2 GiB.
const prefix = setupSuite('chaos');
const BARE = resolveImageName('e2e-bare');
const NAMES = ['a', 'b', 'c'].map((name) => `${prefix}${name}`);
const MARKER = '/root/chaos-marker';
const IMPD_TIMEOUT_MS = 180_000;

// Park-Miller: the seed in the log replays a failed run
const MODULUS = 2_147_483_647;

type Op = 'sleep' | 'wake' | 'exec' | 'stop-start';

type Fault = 'impd' | 'firecracker' | 'container';

function createRandom(seed: number): () => number {
  let state = (seed % (MODULUS - 1)) + 1;

  return () => {
    state = (state * 48_271) % MODULUS;

    return state / MODULUS;
  };
}

const random = createRandom(config.chaosSeed);

function pickOne<T>(items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];

  if (item === undefined) {
    throw new Error('nothing to pick from');
  }

  return item;
}

const proofs = new Map<string, MemoryProof>();

// what each imp's disk must still hold
const markers = new Map<string, string>();

async function findRow(name: string): Promise<ImpRow | undefined> {
  const rows = await listImps();

  return rows.find((row) => row.name === name);
}

// the operation, failures and all: a kill cuts many of them short
async function runOp(op: Op, name: string): Promise<void> {
  if (op === 'stop-start') {
    await tryImp(['stop', name]);
    await tryImp(['start', name]);

    return;
  }

  const args = op === 'exec' ? ['exec', name, '--', 'true'] : [op, name];

  await tryImp(args);
}

async function waitForImpd(): Promise<void> {
  await waitFor(
    'impd to be ready',
    async () => {
      const ready = await checkHealthReady();

      expect(ready).toBeTrue();
    },
    { timeoutMs: IMPD_TIMEOUT_MS },
  );
}

// Firecracker pids in the container, by the imp id in their API socket
async function listContainerVms(): Promise<Map<string, number[]>> {
  const result = await runInContainer(['pgrep', '-a', 'firecracker']);

  const vms = new Map<string, number[]>();

  for (const line of result.stdout.split('\n')) {
    const match = /^(?<pid>\d+) .*\/imps\/(?<id>[^/]+)\/run\/api\.sock/.exec(line);
    const id = match?.groups?.['id'];
    const pid = Number(match?.groups?.['pid']);

    if (id !== undefined) {
      vms.set(id, [...(vms.get(id) ?? []), pid]);
    }
  }

  return vms;
}

// host processes in the cgroup of the container with this id
function findContainerProcesses(containerId: string): number[] {
  const pids: number[] = [];

  for (const entry of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      if (readFileSync(`/proc/${entry}/cgroup`, 'utf8').includes(containerId)) {
        pids.push(Number(entry));
      }
    } catch {
      // gone, or not ours to read
    }
  }

  return pids;
}

async function readLoopDevices(): Promise<string[]> {
  const file = join(instance.dataDir, 'imp.xfs');

  const result = await runCommand(['losetup', '-n', '-O', 'NAME', '-j', file]);

  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}

async function readContainerId(): Promise<string> {
  const id = await runChecked(['docker', 'inspect', '-f', '{{.Id}}', instance.container]);

  return id.trim();
}

// kills the container, waits until none of its processes or its loop device
// is left, and brings it back
async function runContainerKill(): Promise<void> {
  const containerId = await readContainerId();

  await runChecked(['docker', 'kill', instance.container]);

  await waitFor('the killed container to leave no process', () => {
    expect(findContainerProcesses(containerId)).toEqual([]);
  });

  await waitFor(
    'its loop device to detach',
    async () => {
      const devices = await readLoopDevices();

      expect(devices).toEqual([]);
    },
    { timeoutMs: 120_000 },
  );

  await runChecked(['docker', 'rm', '-f', instance.container]);
  await runDevScript('up');
}

// the fault, and the imps it may cost their memory
async function runFault(fault: Fault, idsByName: ReadonlyMap<string, string>): Promise<string[]> {
  if (fault === 'impd') {
    const pid = await findImpdPid();

    if (pid !== null) {
      await runInContainer(['kill', '-9', pid]);
    }

    return [];
  }

  if (fault === 'firecracker') {
    const vms = await listContainerVms();

    const running = NAMES.filter((name) => vms.has(idsByName.get(name) ?? ''));

    if (running.length === 0) {
      return [];
    }

    const name = pickOne(running);

    for (const pid of vms.get(idsByName.get(name) ?? '') ?? []) {
      await runInContainer(['kill', '-9', String(pid)]);
    }

    return [name];
  }

  await runContainerKill();

  return [...NAMES];
}

// every imp settles in a state a user can act on, and each awake one has
// exactly the one VM its record says
async function checkStates(): Promise<void> {
  await waitFor('every imp to settle', async () => {
    const rows = await listImps();

    for (const name of NAMES) {
      const row = rows.find((candidate) => candidate.name === name);
      const state = row?.state ?? 'missing';

      expect(['running', 'sleeping', 'stopped']).toContain(state);
    }
  });

  const rows = await listImps();
  const vms = await listContainerVms();

  for (const row of rows) {
    const count = vms.get(row.id)?.length ?? 0;
    const expected = row.state === 'running' ? 1 : 0;

    expect(`${row.name} ${row.state}: ${String(count)} VMs`).toBe(
      `${row.name} ${row.state}: ${String(expected)} VMs`,
    );
  }

  const known = new Set(rows.map((row) => row.id));

  expect([...vms.keys()].filter((id) => !known.has(id))).toEqual([]);
}

// a fresh proof for an imp that lost its memory, held awake again
async function startFreshProof(name: string): Promise<void> {
  await holdImp(name);

  const proof = await startMemoryProof(name);

  proofs.set(name, proof);
}

// the disk always survives; the memory only where nothing could take it
async function checkImp(name: string, lost: ReadonlySet<string>): Promise<void> {
  const disk = await runInImp(name, 'cat', MARKER);

  const proof = proofs.get(name);

  if (proof === undefined) {
    throw new Error(`no memory proof for ${name}`);
  }

  const kept = await checkMemoryKept(proof);

  const allowed = lost.has(name) ? 'may lose its memory' : 'keeps its memory';

  expect(`${name}: ${disk}`).toBe(`${name}: ${markers.get(name) ?? ''}`);

  if (!kept) {
    expect(`${name} ${allowed}`).toBe(`${name} may lose its memory`);

    await startFreshProof(name);
  }
}

test('setup: three imps with a disk marker and a memory proof', async () => {
  console.log(`    chaos seed ${String(config.chaosSeed)} (E2E_CHAOS_SEED replays it)`);

  for (const name of NAMES) {
    const marker = `${name} ${String(config.chaosSeed)}`;

    await createImp(name, '--image', BARE, '--memory', '512');

    markers.set(name, marker);

    await runShellInImp(name, `echo '${marker}' > ${MARKER} && sync`);

    // only the suite's own operations sleep them
    await startFreshProof(name);
  }
});

test('every imp stays valid through rounds of kills', async () => {
  for (let round = 1; round <= config.chaosRounds; round += 1) {
    const rows = await listImps();

    const idsByName = new Map(rows.map((row) => [row.name, row.id]));

    const ops = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
      op: pickOne<Op>(['sleep', 'wake', 'exec', 'stop-start']),
      name: pickOne(NAMES),
    }));

    const fault = pickOne<Fault>(['impd', 'impd', 'firecracker', 'container']);
    const delayMs = Math.floor(random() * 3000);
    const steps = ops.map((step) => `${step.op} ${step.name}`).join(', ');

    console.log(`    round ${String(round)}: ${steps}; ${fault} after ${String(delayMs)}ms`);

    const running = Promise.allSettled(ops.map((step) => runOp(step.op, step.name)));

    await Bun.sleep(delayMs);

    const cost = await runFault(fault, idsByName);

    await running;
    await waitForImpd();

    // an operation a kill cut short may cost its imp its memory, and a stop
    // and start always does
    const lost = new Set([...cost, ...ops.map((step) => step.name)]);

    await checkStates();

    for (const name of NAMES) {
      await checkImp(name, lost);
    }
  }
});

test('a paused VM whose agent stops answering is restarted by the watchdog', async () => {
  process.env['IMP_WATCHDOG_ACTION'] = 'restart';
  process.env['IMP_WATCHDOG_TIMEOUT_S'] = '10';

  await runDevScript('reboot');
  await waitForImpd();

  const name = NAMES[0] ?? '';

  await runImp('wake', name);

  // the reboot slept and kept the memory; replant only when it did not
  const before = proofs.get(name);

  if (before === undefined) {
    throw new Error(`no memory proof for ${name}`);
  }

  const keptBefore = await checkMemoryKept(before);

  if (!keptBefore) {
    await startFreshProof(name);
  }

  const proof = proofs.get(name);

  const row = await findRow(name);

  // the guest stops; Firecracker and its socket stay
  await runInContainer([
    'curl',
    '-fsS',
    '--unix-socket',
    `/var/lib/imp/imps/${row?.id ?? ''}/run/api.sock`,
    '-X',
    'PATCH',
    'http://localhost/vm',
    '-d',
    '{"state":"Paused"}',
  ]);

  await waitFor(
    `${name} to boot cold by the watchdog`,
    async () => {
      const after = await findRow(name);

      expect(after?.coldBootReason ?? '').toContain('watchdog');
    },
    { timeoutMs: 120_000 },
  );

  await runInImp(name, 'true');

  if (proof === undefined) {
    throw new Error(`no memory proof for ${name}`);
  }

  const kept = await checkMemoryKept(proof);

  expect(kept).toBeFalse();

  await startFreshProof(name);
});

test('a sleep the disk cannot take keeps the imp awake with DISK_FULL', async () => {
  delete process.env['IMP_WATCHDOG_ACTION'];
  delete process.env['IMP_WATCHDOG_TIMEOUT_S'];

  // a reserve past any test disk: a wake still goes through, a sleep not
  process.env['IMP_DISK_RESERVE_GIB'] = '100000';

  try {
    await runDevScript('reboot');
    await waitForImpd();

    const name = NAMES[1] ?? '';

    await runImp('wake', name);

    const result = await tryImp(['sleep', name]);
    const after = await findRow(name);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('DISK_FULL');
    expect(after?.state).toBe('running');
  } finally {
    delete process.env['IMP_DISK_RESERVE_GIB'];

    await runDevScript('reboot');
    await waitForImpd();
  }
});

test('no Firecracker or loop device outlives the instance', async () => {
  const devices = await readLoopDevices();
  const containerId = await readContainerId();
  const vms = await listContainerVms();
  const rows = await listImps();

  const running = rows.filter((row) => row.state === 'running').length;
  const processes = findContainerProcesses(containerId);

  // the instance's own mount, and one VM per running imp
  expect(devices.length).toBeLessThanOrEqual(1);
  expect([...vms.values()].flat()).toHaveLength(running);
  expect(processes.length).toBeGreaterThan(0);
});
