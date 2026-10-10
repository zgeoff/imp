import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  buildBackupEnv,
  findPackKey,
  readBackupStatus,
  removeBackupSecrets,
  runBackup,
  runRestic,
  runS3,
  startMinio,
  startRestic,
  stopMinio,
  writeBackupSecrets,
} from '../lib/backup-drill';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  createInstanceClient,
  listCheckpoints,
  listImps,
  readState,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { holdImp, readGuestFile, waitForExec, writeGuestFile } from '../lib/imps';
import { instance, runDevScript, runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// The restore drill (docs/architecture/backups.md). Each test reboots the
// instance with backups on to a MinIO of its own, with the schedule every
// 60 s, and back to no backups at its end.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const secrets = await writeBackupSecrets();

  stack.defer(() => removeBackupSecrets(secrets));

  return { prefix: readSuitePrefix('backups'), stack, client, secrets };
}

test('it backs up a running imp mid-write, a stopped imp and a checkpoint, adds next to nothing on the next run, and restores one imp or every imp of a point', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-tiny');
  const source = `${ctx.prefix}src`;
  const idle = `${ctx.prefix}idle`;
  const copy = `${ctx.prefix}copy`;

  // impd reads its backup env at start; MinIO joins the new container
  await runDevScript('reboot', instance, buildBackupEnv(ctx.secrets, 60));

  ctx.stack.defer(() => runDevScript('reboot'));

  await startMinio(ctx.secrets);

  ctx.stack.defer(() => stopMinio());

  await runImp('new', source, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, source));

  await waitForExec(source);
  await holdImp(source);
  await writeGuestFile(source, '/root/f', 'v1');
  await runImp('checkpoint', source, 'cp1');
  await writeGuestFile(source, '/root/f', 'v2');
  await runImp('new', idle, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, idle));

  await waitForExec(idle);
  await writeGuestFile(idle, '/root/f', 'idle');
  await runImp('stop', idle);

  // a writer that never stops for long: the freeze lands among its writes
  await runShellInImp(
    source,
    'echo \'i=0; while :; do echo "line $i" >> /root/log; i=$((i+1)); sleep 0.01; done\' > /root/writer.sh && setsid sh /root/writer.sh >/dev/null 2>&1 &',
  );

  const firstStarted = Date.now();

  const first = await runBackup();

  writeMetric('backupFirstMs', Date.now() - firstStarted);
  writeMetric('backupFirstAddedMiB', Math.round(first.dataAddedBytes / 1_048_576));

  // the bracket keeps pkill from matching the shell that runs it
  await runShellInImp(source, 'pkill -f "[w]riter.sh" || true');

  expect(first.imps).toContain(source);
  expect(first.imps).toContain(idle);
  expect(first.skipped).toStrictEqual([]);

  const nextStarted = Date.now();

  const next = await runBackup();

  writeMetric('backupNextMs', Date.now() - nextStarted);
  writeMetric('backupNextAddedMiB', Math.round(next.dataAddedBytes / 1_048_576));

  expect(next.dataAddedBytes).toBeLessThan(first.dataAddedBytes / 4);

  const restoreStarted = Date.now();

  await runImp('backup', 'restore', source, '--as', copy);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, copy));
  writeMetric('backupRestoreMs', Date.now() - restoreStarted);

  const restoredState = await readState(copy);

  expect(restoredState).toBe('stopped');

  await runImp('start', copy);
  await waitForExec(copy);

  const restoredFile = await readGuestFile(copy, '/root/f');

  // the guest's own journal makes the log whole: the last line is complete
  const last = await runShellInImp(copy, 'tail -n 1 /root/log');
  const checkpoints = await listCheckpoints(copy);

  expect(restoredFile).toBe('v2');
  expect(last).toMatch(/^line \d+$/v);
  expect(checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['cp1']);

  await runImp('restore', copy, 'cp1');
  await waitForExec(copy);

  const checkpointFile = await readGuestFile(copy, '/root/f');

  expect(checkpointFile).toBe('v1');

  // restore --all refuses a host with imps, and --merge names the clash
  const all = await tryImp(['backup', 'restore', '--all']);
  const merged = await tryImp(['backup', 'restore', '--all', '--merge']);

  expect(all.exitCode).toBe(1);
  expect(all.stderr).toContain('restore --all --merge');
  expect(merged.exitCode).toBe(1);
  expect(merged.stderr).toMatch(new RegExp(`an imp named ${ctx.prefix}(?:src|idle) exists`, 'v'));

  // the newest point that holds the source: a scheduled run after the
  // removal below would hold none of the journey's imps, and one after the
  // copy's restore holds the copy too
  const status = await readBackupStatus();

  const point = status.points.findLast((candidate) => candidate.imps.includes(source));

  await runImp('rm', source);
  await runImp('rm', idle);
  await runImp('rm', copy);

  const others = await listImps();

  const result = await tryImp([
    'backup',
    'restore',
    '--all',
    '--at',
    point?.time.toISOString() ?? '',
  ]);

  const states = await Promise.all((point?.imps ?? []).map((name) => readState(name)));

  expect(others).toStrictEqual([]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain('stop the old impd');
  expect(point?.imps).toContain(idle);
  expect(point?.imps).toContain(source);
  expect(states).toSatisfyAll((state: string) => state === 'stopped');

  await runImp('start', source);
  await waitForExec(source);

  const sourceFile = await readGuestFile(source, '/root/f');

  expect(sourceFile).toBe('v2');
});

test('it restores a point that survived the scheduled forget and prune, and finds none before it', async () => {
  const ctx = await setupTest();

  const idle = `${ctx.prefix}idle`;
  const survivor = `${ctx.prefix}idle2`;

  await runDevScript('reboot', instance, buildBackupEnv(ctx.secrets, 60));

  ctx.stack.defer(() => runDevScript('reboot'));

  await startMinio(ctx.secrets);

  ctx.stack.defer(() => stopMinio());

  await runImp('new', idle, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, idle));

  await waitForExec(idle);
  await writeGuestFile(idle, '/root/f', 'idle');
  await runImp('stop', idle);
  await runBackup();

  const before = await readBackupStatus();

  const firstTime = before.points[0]?.time ?? new Date();

  // the schedule's first run prunes
  const status = await waitFor(
    'the scheduled prune',
    async () => {
      const current = await readBackupStatus();

      if (current.lastPruneAt === null) {
        throw new Error('no prune yet');
      }

      return current;
    },
    { timeoutMs: (60 + 120) * 1000 },
  );

  writeMetric('backupPointsAfterPrune', status.points.length);

  await runImp('backup', 'restore', idle, '--as', survivor);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, survivor));

  const survivorState = await readState(survivor);

  const early = new Date(firstTime.getTime() - 1000).toISOString();

  const gone = await tryImp([
    'backup',
    'restore',
    idle,
    '--as',
    `${ctx.prefix}idle9`,
    '--at',
    early,
  ]);

  // every run so far fell in one hour: forget keeps only the newest
  expect(status.points.at(-1)?.imps).toContain(idle);
  expect(survivorState).toBe('stopped');
  expect(gone.exitCode).toBe(1);
  expect(gone.stderr).toContain('not found');
});

test('it restores past a stale lock in the repository, and fails the check loudly on a corrupted pack', async () => {
  const ctx = await setupTest();

  const idle = `${ctx.prefix}idle`;
  const unlocked = `${ctx.prefix}idle3`;

  await runDevScript('reboot', instance, buildBackupEnv(ctx.secrets, 60));

  ctx.stack.defer(() => runDevScript('reboot'));

  await startMinio(ctx.secrets);

  ctx.stack.defer(() => stopMinio());

  await runImp('new', idle, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, idle));

  await waitForExec(idle);
  await writeGuestFile(idle, '/root/f', 'idle');
  await runImp('stop', idle);
  await runBackup();

  // `check` takes restic's exclusive lock and, throttled to 16 KiB/s, holds
  // it for minutes on this repository; a SIGKILL leaves it behind
  await startRestic(ctx.secrets, '--limit-download', '16', 'check', '--read-data');

  await waitFor('restic check to take its lock', async () => {
    const held = await runRestic(ctx.secrets, 'list', 'locks', '--no-lock');

    if (held.stdout.trim() === '') {
      throw new Error('no lock yet');
    }
  });

  await runInContainer(['pkill', '-9', '-f', 'restic --limit-download']);

  const locks = await runRestic(ctx.secrets, 'list', 'locks', '--no-lock');

  const lockId = locks.stdout.trim().split('\n')[0] ?? '';

  const lock = await runRestic(ctx.secrets, 'cat', 'lock', lockId, '--no-lock');

  expect(lock.stdout).toContain('"exclusive": true');

  await runImp('backup', 'restore', idle, '--as', unlocked);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, unlocked));

  const unlockedState = await readState(unlocked);

  expect(unlockedState).toBe('stopped');

  const listing = await runS3(ctx.secrets, 'GET', '?list-type=2&prefix=data/');

  const key = findPackKey(listing.stdout) ?? '';

  // kept, so the repository is whole again after the check
  const saved = await runS3(ctx.secrets, 'GET', `/${key}`, '-o', '/tmp/e2e-pack');

  const put = await runS3(
    ctx.secrets,
    'PUT',
    `/${key}`,
    '--data-binary',
    randomBytes(4096).toString('hex'),
  );

  expect(key).not.toBe('');
  expect(saved.exitCode).toBe(0);
  expect(put.exitCode).toBe(0);

  const check = await tryImp(['backup', 'check', '--subset', '100%']);
  const status = await readBackupStatus();
  const restored = await runS3(ctx.secrets, 'PUT', `/${key}`, '--data-binary', '@/tmp/e2e-pack');

  expect(check.exitCode).toBe(1);
  expect(status.lastCheck?.error).toBeString();
  expect(restored.exitCode).toBe(0);
});
