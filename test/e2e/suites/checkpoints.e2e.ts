import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { checkLimit } from '../lib/check-limit';
import { hasCheckpointStorage, hasImpDir, writeCrossFiles } from '../lib/checkpoint-storage';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  createInstanceClient,
  listCheckpoints,
  readState,
  requireImp,
  runImp,
  runInImp,
  tryImp,
} from '../lib/imp-cli';
import { holdImp, readGuestFile, waitForExec, writeGuestFile } from '../lib/imps';
import { readImpdLoggedMs } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { writeMetric } from '../lib/write-metric';

// `imp checkpoint`, `imp restore` and `imp fork` on the instance's storage
// backend: a reflink on XFS, a snapshot on ZFS. Each test boots its own
// source imp and takes its own checkpoints.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('checkpoints'), stack, client };
}

test('it restores the disk of a running imp from its checkpoint, within the limit', async () => {
  const ctx = await setupTest();

  const source = `${ctx.prefix}run`;

  await runImp('new', source, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, source));

  await waitForExec(source);
  await holdImp(source);
  await writeGuestFile(source, '/root/f', 'v1');

  const checkpointStarted = Date.now();

  await runImp('checkpoint', source, 'cp1');

  writeMetric('checkpointMs', Date.now() - checkpointStarted);

  const [cp1] = await listCheckpoints(source);

  invariant(cp1);

  // impd's own timing, without the CLI round trip
  const impdMs = await readImpdLoggedMs(`${source}: checkpoint ${cp1.id} in`);

  invariant(impdMs);
  checkLimit('checkpoint (impd)', impdMs, config.maxCheckpointMs);

  const row = await requireImp(source);
  const hasDisk = await hasCheckpointStorage(row.id, cp1.id);

  expect(cp1.label).toBe('cp1');
  expect(hasDisk).toBeTrue();

  await writeGuestFile(source, '/root/f', 'v2');
  await writeGuestFile(source, '/root/g', 'later');

  const restoreStarted = Date.now();

  await runImp('restore', source, 'cp1');
  await waitForExec(source);

  writeMetric('restoreMs', Date.now() - restoreStarted);

  const state = await readState(source);
  const restored = await readGuestFile(source, '/root/f');
  const later = await readGuestFile(source, '/root/g');

  expect(state).toBe('running');
  expect(restored).toBe('v1');
  expect(later).toBe('none');
});

test('it leaves a stopped imp stopped on a restore, with the checkpoint’s disk at its next start', async () => {
  const ctx = await setupTest();

  const source = `${ctx.prefix}stop`;

  await runImp('new', source, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, source));

  await waitForExec(source);
  await holdImp(source);
  await writeGuestFile(source, '/root/f', 'v1');
  await runImp('checkpoint', source, 'cp1');
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

test('it makes a fork from a checkpoint and a fork from the live disk independent imps', async () => {
  const ctx = await setupTest();

  const source = `${ctx.prefix}src`;
  const fromCheckpoint = `${ctx.prefix}fork-cp`;
  const fromLive = `${ctx.prefix}fork-live`;

  await runImp('new', source, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, source));

  await waitForExec(source);
  await holdImp(source);
  await writeGuestFile(source, '/root/f', 'v1');
  await runImp('checkpoint', source, 'cp1');
  await writeGuestFile(source, '/root/f', 'v2');

  const checkpointForkStarted = Date.now();

  await runImp('fork', source, fromCheckpoint, '--from', 'cp1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, fromCheckpoint));

  await waitForExec(fromCheckpoint);

  writeMetric('forkCheckpointMs', Date.now() - checkpointForkStarted);

  await holdImp(fromCheckpoint);

  const forked = await readGuestFile(fromCheckpoint, '/root/f');
  const unchanged = await readGuestFile(source, '/root/f');
  const sourceAndCheckpointFork = await writeCrossFiles(source, fromCheckpoint, 'cp');

  expect(forked).toBe('v1');
  expect(unchanged).toBe('v2');
  expect(sourceAndCheckpointFork.seenInA).toBe('none');
  expect(sourceAndCheckpointFork.seenInB).toBe('none');
  expect(sourceAndCheckpointFork.ownInB).toBe('b');

  const liveForkStarted = Date.now();

  await runImp('fork', source, fromLive);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, fromLive));

  await waitForExec(fromLive);

  writeMetric('forkLiveMs', Date.now() - liveForkStarted);

  await holdImp(fromLive);

  const fork = await requireImp(fromLive);
  const sourceRow = await requireImp(source);
  const hostname = await runInImp(fromLive, 'hostname');
  const forkCheckpoints = await listCheckpoints(fromLive);
  const live = await readGuestFile(fromLive, '/root/f');
  const earlier = await readGuestFile(fromLive, '/root/only-cp-a');
  const sourceAndLiveFork = await writeCrossFiles(source, fromLive, 'live');
  const theForks = await writeCrossFiles(fromLive, fromCheckpoint, 'forks');

  expect(fork.state).toBe('running');
  expect(fork.id).not.toBe(sourceRow.id);
  expect(hostname).toBe(fromLive);
  expect(forkCheckpoints).toBeEmpty();
  expect(live).toBe('v2');
  expect(earlier).toBe('a');
  expect(sourceAndLiveFork.seenInA).toBe('none');
  expect(sourceAndLiveFork.seenInB).toBe('none');
  expect(sourceAndLiveFork.ownInB).toBe('b');
  expect(theForks.seenInA).toBe('none');
  expect(theForks.seenInB).toBe('none');
  expect(theForks.ownInB).toBe('b');
});

test('it lists checkpoints newest first, refuses a label taken, and deletes one with its storage', async () => {
  const ctx = await setupTest();

  const source = `${ctx.prefix}list`;

  await runImp('new', source, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, source));

  await waitForExec(source);
  await holdImp(source);
  await runImp('checkpoint', source, 'cp1');
  await runImp('checkpoint', source);

  const listed = await listCheckpoints(source);
  const duplicate = await tryImp(['checkpoint', source, 'cp1']);

  const [, cp1] = listed;

  expect(listed).toHaveLength(2);
  expect(cp1?.label).toBe('cp1');

  expect(duplicate).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'imp: CONFLICT: checkpoint cp1 already exists\n',
  });

  invariant(cp1);

  const row = await requireImp(source);

  await runImp('checkpoint', 'rm', source, 'cp1');

  const remaining = await listCheckpoints(source);
  const hasDisk = await hasCheckpointStorage(row.id, cp1.id);
  const restore = await tryImp(['restore', source, 'cp1']);

  expect(remaining).toHaveLength(1);
  expect(hasDisk).toBeFalse();

  expect(restore).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'imp: NOT_FOUND: checkpoint cp1 not found\n',
  });
});

test('it deletes the checkpoints with the imp on rm, and a fork from one outlives its source', async () => {
  const ctx = await setupTest();

  const source = `${ctx.prefix}rm`;
  const fork = `${ctx.prefix}rm-fork`;

  await runImp('new', source, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, source));

  await waitForExec(source);
  await holdImp(source);
  await writeGuestFile(source, '/root/f', 'v1');
  await runImp('checkpoint', source, 'cp1');
  await runImp('fork', source, fork, '--from', 'cp1');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, fork));

  await waitForExec(fork);
  await holdImp(fork);

  const row = await requireImp(source);

  await runImp('rm', source);

  const hasDir = await hasImpDir(row.id);
  const forked = await readGuestFile(fork, '/root/f');

  expect(hasDir).toBeFalse();
  expect(forked).toBe('v1');
});
