import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listImps, tryImp } from './imp-cli';
import {
  checkHealthReady,
  findImpdPid,
  instance,
  runChecked,
  runCommand,
  runDevScript,
  runInContainer,
} from './instance';
import { waitFor } from './wait-for';

// The chaos suite's rounds: random operations cut short by a kill of impd, a
// Firecracker or the container, as a property runner drives them.

type ChaosOp = 'sleep' | 'wake' | 'exec' | 'stop-start';

export type ChaosFault = 'impd' | 'firecracker' | 'container';

export interface ChaosStep {
  readonly op: ChaosOp;
  readonly name: string;
}

export interface ChaosRound {
  readonly steps: readonly ChaosStep[];
  readonly fault: ChaosFault;

  // how long the operations run before the fault
  readonly delayMs: number;
}

const MODULUS = 2_147_483_647;

// Park-Miller, so the seed in the log replays a failed run
export function createParkMiller(seed: number): () => number {
  let state = (seed % (MODULUS - 1)) + 1;

  return () => {
    state = (state * 48_271) % MODULUS;

    return state / MODULUS;
  };
}

export function pickOne<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];

  if (item === undefined) {
    throw new RangeError('nothing to pick from');
  }

  return item;
}

// An exec that outlasts the fault's offset, so some operation is always in
// flight when it lands, then up to two more operations on the imps, then a
// fault, impd's twice as likely, within 3 s.
export function planChaosRound(random: () => number, names: readonly string[]): ChaosRound {
  const held: ChaosStep = { op: 'exec', name: pickOne(random, names) };

  const others = Array.from({ length: Math.floor(random() * 3) }, () => ({
    op: pickOne<ChaosOp>(random, ['sleep', 'wake', 'exec', 'stop-start']),
    name: pickOne(random, names),
  }));

  const fault = pickOne<ChaosFault>(random, ['impd', 'impd', 'firecracker', 'container']);

  return { steps: [held, ...others], fault, delayMs: Math.floor(random() * 3000) };
}

// how long an exec step runs in the guest: past the latest fault offset
export const CHAOS_EXEC_S = 4;

// The imp a Firecracker kill takes: one whose VM runs, or null when none
// does.
export function pickFaultVictim(
  random: () => number,
  names: readonly string[],
  idsByName: ReadonlyMap<string, string>,
  vms: ReadonlyMap<string, readonly number[]>,
): string | null {
  const running = names.filter((name) => vms.has(idsByName.get(name) ?? ''));

  return running.length === 0 ? null : pickOne(random, running);
}

export interface ImpVmRow {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

// each imp's state and the VMs it has, as a line a failure reads at once
export function listImpVmCounts(
  rows: readonly ImpVmRow[],
  vms: ReadonlyMap<string, readonly number[]>,
): string[] {
  return rows.map((row) => `${row.name} ${row.state}: ${String(vms.get(row.id)?.length ?? 0)} VMs`);
}

// The VMs each imp should have: one while running, and one in `error`
// where an adopt left a VM that outlived SIGKILL, with its pid on record.
export function listExpectedImpVmCounts(
  rows: readonly ImpVmRow[],
  vms: ReadonlyMap<string, readonly number[]>,
): string[] {
  return rows.map((row) => {
    const count = vms.get(row.id)?.length ?? 0;
    const owned = row.state === 'running' || (row.state === 'error' && count > 0) ? 1 : 0;

    return `${row.name} ${row.state}: ${String(owned)} VMs`;
  });
}

// the VMs no imp owns
export function findStrayVms(
  rows: readonly ImpVmRow[],
  vms: ReadonlyMap<string, readonly number[]>,
): string[] {
  const known = new Set(rows.map((row) => row.id));

  return [...vms.keys()].filter((id) => !known.has(id));
}

const SETTLED_STATES = new Set(['running', 'sleeping', 'stopped', 'error']);

// the imps of `names` not yet in a state a user can act on
export function findUnsettledImps(rows: readonly ImpVmRow[], names: readonly string[]): string[] {
  return names.filter((name) => {
    const state = rows.find((row) => row.name === name)?.state ?? 'missing';

    return !SETTLED_STATES.has(state);
  });
}

// The imps a round may cost their memory: those the fault took, every stop
// and start, and any step a fault other than a Firecracker kill cut short.
export function findLostImps(round: Readonly<ChaosRound>, taken: readonly string[]): Set<string> {
  const cut = round.steps.filter(
    (step) => step.op === 'stop-start' || round.fault !== 'firecracker',
  );

  return new Set([...taken, ...cut.map((step) => step.name)]);
}

// Firecracker pids by the imp id in their API socket, from `pgrep -a`
export function parseFirecrackerVms(stdout: string): Map<string, number[]> {
  const vms = new Map<string, number[]>();

  for (const line of stdout.split('\n')) {
    const match = /^(?<pid>\d+) .*\/imps\/(?<id>[^\/]+)\/run\/api\.sock/v.exec(line);
    const id = match?.groups?.['id'];

    if (id !== undefined) {
      vms.set(id, [...(vms.get(id) ?? []), Number(match?.groups?.['pid'])]);
    }
  }

  return vms;
}

// Thin glue over the dev instance and this host below.

export async function listContainerVms(): Promise<Map<string, number[]>> {
  const result = await runInContainer(['pgrep', '-a', 'firecracker']);

  return parseFirecrackerVms(result.stdout);
}

// host processes in the cgroup of the container with this id
export function findContainerProcesses(containerId: string): number[] {
  const pids: number[] = [];

  for (const entry of readdirSync('/proc').filter((name) => /^\d+$/v.test(name))) {
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

export async function readLoopDevices(): Promise<string[]> {
  const result = await runCommand([
    'losetup',
    '-n',
    '-O',
    'NAME',
    '-j',
    join(instance.dataDir, 'imp.xfs'),
  ]);

  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}

export async function readContainerId(): Promise<string> {
  const id = await runChecked(['docker', 'inspect', '-f', '{{.Id}}', instance.container]);

  return id.trim();
}

export async function waitForImpd(): Promise<void> {
  await waitFor(
    'impd to be ready',
    async () => {
      const isReady = await checkHealthReady();

      if (!isReady) {
        throw new Error('impd is not ready');
      }
    },
    { timeoutMs: 180_000 },
  );
}

// the operation, failures and all: a kill cuts many of them short
export async function runChaosStep(step: Readonly<ChaosStep>): Promise<void> {
  if (step.op === 'stop-start') {
    await tryImp(['stop', step.name]);
    await tryImp(['start', step.name]);

    return;
  }

  const args =
    step.op === 'exec'
      ? ['exec', step.name, '--', 'sleep', String(CHAOS_EXEC_S)]
      : [step.op, step.name];

  await tryImp(args);
}

// kills the container, waits until none of its processes or its loop device
// is left, and brings it back
async function runContainerKill(containerId: string): Promise<void> {
  await runChecked(['docker', 'kill', instance.container]);

  await waitFor('the killed container to leave no process', () => {
    const left = findContainerProcesses(containerId);

    if (left.length > 0) {
      throw new Error(`pids ${left.join(', ')} left`);
    }
  });

  await waitFor(
    'its loop device to detach',
    async () => {
      const devices = await readLoopDevices();

      if (devices.length > 0) {
        throw new Error(`${devices.join(', ')} still attached`);
      }
    },
    { timeoutMs: 120_000 },
  );

  await runChecked(['docker', 'rm', '-f', instance.container]);
  await runDevScript('up');
}

export interface ChaosFaultResult {
  // the imps whose memory it took
  readonly taken: readonly string[];

  // what it killed: impd's pid, a VM's pids, or the container's id
  readonly killed: readonly string[];
}

async function runKillInContainer(pid: string): Promise<void> {
  const result = await runInContainer(['kill', '-9', pid]);

  if (result.exitCode !== 0) {
    throw new Error(`kill -9 ${pid} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
}

// The fault, which throws when it finds nothing to kill: a round whose
// fault never happened proves nothing.
export async function runChaosFault(
  fault: ChaosFault,
  names: readonly string[],
  idsByName: ReadonlyMap<string, string>,
  random: () => number,
): Promise<ChaosFaultResult> {
  if (fault === 'impd') {
    const pid = await findImpdPid();

    if (pid === null) {
      throw new Error('no impd to kill');
    }

    await runKillInContainer(pid);

    return { taken: [], killed: [pid] };
  }

  if (fault === 'firecracker') {
    const vms = await listContainerVms();

    const name = pickFaultVictim(random, names, idsByName, vms);

    if (name === null) {
      throw new Error('no Firecracker runs to kill');
    }

    const pids = (vms.get(idsByName.get(name) ?? '') ?? []).map(String);

    for (const pid of pids) {
      await runKillInContainer(pid);
    }

    return { taken: [name], killed: pids };
  }

  const containerId = await readContainerId();

  await runContainerKill(containerId);

  return { taken: names, killed: [containerId] };
}

// the rows of the imps, once every one of `names` is in a state a user can
// act on
export function readSettledImps(names: readonly string[]): Promise<readonly ImpVmRow[]> {
  return waitFor('every imp to settle', async () => {
    const rows = await listImps();

    const unsettled = findUnsettledImps(rows, names);

    if (unsettled.length > 0) {
      throw new Error(`${unsettled.join(', ')} not settled`);
    }

    return rows;
  });
}
