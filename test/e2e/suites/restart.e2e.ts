import { expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { getThroughProxy } from '../lib/http';
import {
  assertState,
  listCheckpoints,
  listImps,
  readState,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { createImp, holdImp, readGuestFile, waitForExec, writeGuestFile } from '../lib/imps';
import { checkHealthReady, findImpdPid, runDevScript } from '../lib/instance';
import type { MemoryProof } from '../lib/memory-proof';
import { checkMemoryProof, startMemoryProof } from '../lib/memory-proof';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('restart');
const TINY = resolveImageName('e2e-tiny');
const BARE = resolveImageName('e2e-bare');
const disk = `${prefix}disk`;
const mem = `${prefix}mem`;
const stopped = `${prefix}stopped`;
const BOOT_ID = 'cat /proc/sys/kernel/random/boot_id';
let proof: MemoryProof;
let diskBootId: string;

// Every imp (scale's too, when it ran first) without volatile fields, with
// its checkpoint ids: a restart must keep all of it.
async function readInventory(): Promise<readonly unknown[]> {
  const rows = await listImps();

  const inventory: unknown[] = [];

  for (const row of rows.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const checkpoints = await listCheckpoints(row.name);

    inventory.push({
      name: row.name,
      id: row.id,
      image: row.image,
      slot: row.slot,
      port: row.port,
      vcpus: row.vcpus,
      memoryMib: row.memoryMib,
      checkpoints: checkpoints.map((checkpoint) => checkpoint.id).toSorted(),
    });
  }

  return inventory;
}

async function listAwakeImps(): Promise<readonly string[]> {
  const rows = await listImps();

  return rows
    .filter((row) => row.state !== 'sleeping' && row.state !== 'stopped')
    .map((row) => `${row.name} ${row.state}`);
}

test('setup: a running imp with a checkpoint, a sleeping imp and a stopped imp', async () => {
  await createImp(disk, '--image', TINY, '--memory', '512');
  await holdImp(disk);
  await writeGuestFile(disk, '/root/f', 'r1');
  await runImp('checkpoint', disk, 'r1');
  await writeGuestFile(disk, '/root/f', 'r2');

  diskBootId = await runShellInImp(disk, BOOT_ID);

  await createImp(mem, '--image', BARE, '--memory', '512');

  proof = await startMemoryProof(mem);

  // the idle sleeper may get there first
  await tryImp(['sleep', mem]);
  await waitFor(`${mem} to sleep`, () => assertState(mem, 'sleeping'));
  await createImp(stopped, '--image', TINY, '--memory', '512');
  await runImp('stop', stopped);
});

test('an impd restart re-adopts running VMs and keeps every imp and checkpoint', async () => {
  const before = await readInventory();
  const oldPid = await findImpdPid();

  expect(oldPid).not.toBeNull();

  console.log(`    ${String(before.length)} imps before the restart`);

  const started = Date.now();

  // dev.sh restart can return while the old impd still answers /health, so
  // wait for a new impd process before trusting readiness
  await runDevScript('restart');

  await waitFor(
    'a new impd process',
    async () => {
      const pid = await findImpdPid();

      expect(pid).not.toBeNull();
      expect(pid).not.toBe(oldPid);
    },
    { timeoutMs: 180_000 },
  );

  await waitFor(
    'the new impd to be ready',
    async () => {
      const ready = await checkHealthReady();

      expect(ready).toBeTrue();
    },
    { timeoutMs: 120_000 },
  );

  writeMetric('restartMs', Date.now() - started);

  const after = await readInventory();
  const diskState = await readState(disk);
  const bootId = await runShellInImp(disk, BOOT_ID);
  const file = await readGuestFile(disk, '/root/f');
  const stoppedState = await readState(stopped);

  expect(after).toEqual(before);

  // re-adopted, not rebooted: the same boot and the latest write
  expect(diskState).toBe('running');
  expect(bootId).toBe(diskBootId);
  expect(file).toBe('r2');
  expect(stoppedState).toBe('stopped');
});

test('a sleeping imp wakes with its memory after an impd restart', async () => {
  const body = await getThroughProxy(mem);

  expect(body).toBe(proof.token);

  await checkMemoryProof(proof);
});

test('a checkpoint taken before the restart restores', async () => {
  await runImp('restore', disk, 'r1');
  await waitForExec(disk);

  const file = await readGuestFile(disk, '/root/f');

  expect(file).toBe('r1');
});

test('stopping the instance sleeps every imp and they wake intact', async () => {
  await holdImp(mem);

  const before = await readInventory();

  const started = Date.now();

  // dev.sh reboot: SIGTERM makes impd sleep every VM before it exits
  await runDevScript('reboot');

  writeMetric('rebootMs', Date.now() - started);

  const after = await readInventory();
  const awake = await listAwakeImps();
  const memState = await readState(mem);
  const stoppedState = await readState(stopped);

  expect(after).toEqual(before);
  expect(awake).toBeEmpty();
  expect(memState).toBe('sleeping');
  expect(stoppedState).toBe('stopped');

  const body = await getThroughProxy(mem);

  expect(body).toBe(proof.token);

  await checkMemoryProof(proof);
});
