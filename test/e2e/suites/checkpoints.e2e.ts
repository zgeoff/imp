import { expect, test } from 'bun:test';
import { checkLimit } from '../lib/check-limit';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  listCheckpoints,
  readInfo,
  readState,
  requireImp,
  runImp,
  runInImp,
  tryImp,
} from '../lib/imp-cli';
import {
  createImp,
  holdImp,
  readGuestFile,
  registerImp,
  removeImps,
  waitForExec,
  writeGuestFile,
} from '../lib/imps';
import { readImpdLoggedMs, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('checkpoints');
const TINY = resolveImageName('e2e-tiny');
const source = `${prefix}src`;
const fromCheckpoint = `${prefix}fork-cp`;
const fromLive = `${prefix}fork-live`;
const IMP_DIR = '/var/lib/imp/imps';

// a write on one side is invisible on the other
async function assertIndependent(a: string, b: string, tag: string): Promise<void> {
  await writeGuestFile(a, `/root/only-${tag}-a`, 'a');
  await writeGuestFile(b, `/root/only-${tag}-b`, 'b');

  const seenInA = await readGuestFile(a, `/root/only-${tag}-b`);
  const seenInB = await readGuestFile(b, `/root/only-${tag}-a`);
  const own = await readGuestFile(b, `/root/only-${tag}-b`);

  expect(seenInA).toBe('none');
  expect(seenInB).toBe('none');
  expect(own).toBe('b');
}

async function checkInContainer(...argv: readonly string[]): Promise<boolean> {
  const result = await runInContainer(argv);

  return result.exitCode === 0;
}

// A reflink file on XFS; on ZFS a snapshot not yet marked for destroy (one a
// fork still needs stays, marked, until the fork goes).
async function hasCheckpointStorage(impId: string, checkpointId: string): Promise<boolean> {
  const info = await readInfo();

  if (info.storage.backend === 'xfs') {
    return checkInContainer('test', '-e', `${IMP_DIR}/${impId}/checkpoints/${checkpointId}`);
  }

  return checkInContainer(
    'sh',
    '-c',
    `zfs list -H -t snapshot -o name,defer_destroy | awk -F '\t' -v id="@$1" 'substr($1, length($1) - length(id) + 1) == id && $2 == "off" { found = 1 } END { exit !found }'`,
    'sh',
    checkpointId,
  );
}

test('a checkpoint of a running imp restores its disk', async () => {
  await createImp(source, '--image', TINY, '--memory', '512');
  await holdImp(source);
  await writeGuestFile(source, '/root/f', 'v1');

  let started = Date.now();

  await runImp('checkpoint', source, 'cp1');

  writeMetric('checkpointMs', Date.now() - started);

  const checkpoints = await listCheckpoints(source);

  const cp1 = checkpoints[0]?.id ?? '';

  expect(checkpoints[0]?.label).toBe('cp1');

  // impd's own timing, without the CLI round trip
  const impdMs = await readImpdLoggedMs(`${source}: checkpoint ${cp1} in`);

  if (impdMs === null) {
    throw new Error(`impd logged no checkpoint time for ${source}`);
  }

  checkLimit('checkpoint (impd)', impdMs, config.maxCheckpointMs);

  const row = await requireImp(source);
  const hasDisk = await hasCheckpointStorage(row.id, cp1);

  expect(hasDisk).toBeTrue();

  await writeGuestFile(source, '/root/f', 'v2');
  await writeGuestFile(source, '/root/g', 'later');

  started = Date.now();

  await runImp('restore', source, 'cp1');
  await waitForExec(source);

  writeMetric('restoreMs', Date.now() - started);

  const state = await readState(source);
  const restored = await readGuestFile(source, '/root/f');
  const later = await readGuestFile(source, '/root/g');

  expect(state).toBe('running');
  expect(restored).toBe('v1');
  expect(later).toBe('none');
});

test('restoring a stopped imp leaves it stopped', async () => {
  await writeGuestFile(source, '/root/f', 'v3');
  await runImp('stop', source);
  await runImp('restore', source, 'cp1');

  const state = await readState(source);

  expect(state).toBe('stopped');

  await runImp('start', source);
  await holdImp(source);

  const restored = await readGuestFile(source, '/root/f');

  expect(restored).toBe('v1');
});

test('a fork from a checkpoint and a fork from the live disk are independent imps', async () => {
  await writeGuestFile(source, '/root/f', 'v2');

  registerImp(fromCheckpoint);

  let started = Date.now();

  await runImp('fork', source, fromCheckpoint, '--from', 'cp1');
  await waitForExec(fromCheckpoint);

  writeMetric('forkCheckpointMs', Date.now() - started);

  await holdImp(fromCheckpoint);

  const forked = await readGuestFile(fromCheckpoint, '/root/f');
  const unchanged = await readGuestFile(source, '/root/f');

  expect(forked).toBe('v1');
  expect(unchanged).toBe('v2');

  await assertIndependent(source, fromCheckpoint, 'cp');

  registerImp(fromLive);

  started = Date.now();

  await runImp('fork', source, fromLive);
  await waitForExec(fromLive);

  writeMetric('forkLiveMs', Date.now() - started);

  await holdImp(fromLive);

  const fork = await requireImp(fromLive);
  const sourceRow = await requireImp(source);
  const hostname = await runInImp(fromLive, 'hostname');
  const forkCheckpoints = await listCheckpoints(fromLive);
  const live = await readGuestFile(fromLive, '/root/f');
  const earlier = await readGuestFile(fromLive, '/root/only-cp-a');

  expect(fork.state).toBe('running');
  expect(fork.id).not.toBe(sourceRow.id);
  expect(hostname).toBe(fromLive);
  expect(forkCheckpoints).toBeEmpty();
  expect(live).toBe('v2');
  expect(earlier).toBe('a');

  await assertIndependent(source, fromLive, 'live');
  await assertIndependent(fromLive, fromCheckpoint, 'forks');
});

test('checkpoints list newest first, take unique labels and can be deleted', async () => {
  await runImp('checkpoint', source);

  const listed = await listCheckpoints(source);

  expect(listed).toHaveLength(2);
  expect(listed[1]?.label).toBe('cp1');

  const duplicate = await tryImp(['checkpoint', source, 'cp1']);

  expect(duplicate.exitCode).not.toBe(0);

  const cp1 = listed[1]?.id ?? '';

  const row = await requireImp(source);

  await runImp('checkpoint', 'rm', source, 'cp1');

  const remaining = await listCheckpoints(source);
  const hasDisk = await hasCheckpointStorage(row.id, cp1);
  const restore = await tryImp(['restore', source, 'cp1']);

  expect(remaining).toHaveLength(1);
  expect(hasDisk).toBeFalse();
  expect(restore.exitCode).not.toBe(0);
});

test('rm deletes the checkpoints with the imp, and a fork outlives its source', async () => {
  const row = await requireImp(source);

  await removeImps(source);

  const hasDir = await checkInContainer('test', '-e', `${IMP_DIR}/${row.id}`);
  const forked = await readGuestFile(fromCheckpoint, '/root/f');

  expect(hasDir).toBeFalse();
  expect(forked).toBe('v1');
});
