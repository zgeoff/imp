import { expect } from 'bun:test';
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

// one to three operations on the imps, then a fault, impd's twice as likely,
// within 3 s
export function planChaosRound(random: () => number, names: readonly string[]): ChaosRound {
  const steps = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
    op: pickOne<ChaosOp>(random, ['sleep', 'wake', 'exec', 'stop-start']),
    name: pickOne(random, names),
  }));

  const fault = pickOne<ChaosFault>(random, ['impd', 'impd', 'firecracker', 'container']);

  return { steps, fault, delayMs: Math.floor(random() * 3000) };
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

  const args = step.op === 'exec' ? ['exec', step.name, '--', 'true'] : [step.op, step.name];

  await tryImp(args);
}

// kills the container, waits until none of its processes or its loop device
// is left, and brings it back
async function runContainerKill(): Promise<void> {
  const containerId = await readContainerId();

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

// the fault, and the imps it took their memory from
export async function runChaosFault(
  fault: ChaosFault,
  names: readonly string[],
  idsByName: ReadonlyMap<string, string>,
  random: () => number,
): Promise<readonly string[]> {
  if (fault === 'impd') {
    const pid = await findImpdPid();

    if (pid !== null) {
      await runInContainer(['kill', '-9', pid]);
    }

    return [];
  }

  if (fault === 'firecracker') {
    const vms = await listContainerVms();

    const running = names.filter((name) => vms.has(idsByName.get(name) ?? ''));

    if (running.length === 0) {
      return [];
    }

    const name = pickOne(random, running);

    for (const pid of vms.get(idsByName.get(name) ?? '') ?? []) {
      await runInContainer(['kill', '-9', String(pid)]);
    }

    return [name];
  }

  await runContainerKill();

  return names;
}

// Every imp settles in a state a user can act on, and each awake one has
// exactly the one VM its record says; returns the imps in `error`, where an
// adopt leaves one whose VM outlived SIGKILL, with the pid on its record.
export async function checkChaosStates(names: readonly string[]): Promise<Set<string>> {
  await waitFor('every imp to settle', async () => {
    const rows = await listImps();

    const states = names.map((name) => rows.find((row) => row.name === name)?.state ?? 'missing');

    expect(states).toSatisfyAll((state: string) =>
      ['running', 'sleeping', 'stopped', 'error'].includes(state),
    );
  });

  const rows = await listImps();
  const vms = await listContainerVms();

  const counts = rows.map(
    (row) => `${row.name} ${row.state}: ${String(vms.get(row.id)?.length ?? 0)} VMs`,
  );

  const expected = rows.map((row) => {
    const count = vms.get(row.id)?.length ?? 0;
    const owned = row.state === 'running' || (row.state === 'error' && count > 0) ? 1 : 0;

    return `${row.name} ${row.state}: ${String(owned)} VMs`;
  });

  const known = new Set(rows.map((row) => row.id));

  expect(counts).toStrictEqual(expected);
  expect([...vms.keys()].filter((id) => !known.has(id))).toStrictEqual([]);

  return new Set(rows.filter((row) => row.state === 'error').map((row) => row.name));
}
