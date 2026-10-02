import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { resolveImageName } from '../lib/fixtures';
import { listCheckpoints, readState, runImp, runShellInImp, tryImp } from '../lib/imp-cli';
import {
  createImp,
  holdImp,
  readGuestFile,
  registerImp,
  waitForExec,
  writeGuestFile,
} from '../lib/imps';
import {
  REPO_ROOT,
  instance,
  runChecked,
  runCommand,
  runDevScript,
  runInContainer,
} from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// The restore drill (docs/architecture/backups.md): impd backs up to MinIO in
// a container that shares the dev instance's network, so impd reaches it on
// 127.0.0.1:9000. The image is pinned by digest.
const MINIO_IMAGE =
  'cgr.dev/chainguard/minio@sha256:0f95aa412a12351a95bb43c3b54b66440eb0aa022bb3f3458942678a489e915b';

const prefix = setupSuite('backups');
const TINY = resolveImageName('e2e-tiny');
const source = `${prefix}src`;
const idle = `${prefix}idle`;
const copy = `${prefix}copy`;
const minio = `${instance.container}-minio`;
const bucket = 'imp-e2e';
const repository = `s3:http://127.0.0.1:9000/${bucket}`;

// Throwaway keys for a throwaway bucket. The password file is in the repo,
// which the dev container mounts at /src.
const secretsDir = join(REPO_ROOT, '.cache', 'e2e', 'backups');
const accessKey = 'e2e-backups';
const secretKey = randomBytes(18).toString('hex');
const envFile = join(secretsDir, 'restic.env');
const passwordFile = join(secretsDir, 'restic-password');
const passwordInContainer = `/src/${passwordFile.slice(REPO_ROOT.length + 1)}`;

// the schedule runs often enough to prune within the suite
const INTERVAL_S = 60;
const SkipSchema = z.object({ name: z.string(), reason: z.string() });
const PointSchema = z.object({ id: z.string(), time: z.coerce.date(), imps: z.array(z.string()) });
const CheckSchema = z.object({ at: z.coerce.date(), error: z.string().optional() });

const BackupRunSchema = z.object({
  snapshotId: z.string(),
  imps: z.array(z.string()),
  skipped: z.array(SkipSchema),
  dataAddedBytes: z.number(),
  durationMs: z.number(),
});

const BackupStatusSchema = z.object({
  points: z.array(PointSchema),
  lastPruneAt: z.coerce.date().nullable(),
  lastCheck: CheckSchema.nullable(),
});

const BACKUP_ENV = {
  IMP_BACKUP_REPOSITORY: repository,
  IMP_BACKUP_PASSWORD_FILE: passwordInContainer,
  IMP_BACKUP_INTERVAL_S: String(INTERVAL_S),
  IMP_BACKUP_MEMORY_MIB: '256',
  IMP_DEV_BACKUP_ENV_FILE: envFile,
};

async function runBackup() {
  const stdout = await runImp('backup', 'run', '--json');

  return BackupRunSchema.parse(JSON.parse(stdout));
}

async function readStatus() {
  const stdout = await runImp('backup', 'ls', '--json');

  return BackupStatusSchema.parse(JSON.parse(stdout));
}

// restic in the dev container, with impd's repository and keys
function runRestic(...args: readonly string[]) {
  return runCommand([
    'docker',
    'exec',
    '--env-file',
    envFile,
    '-e',
    `RESTIC_REPOSITORY=${repository}`,
    '-e',
    `RESTIC_PASSWORD_FILE=${passwordInContainer}`,
    instance.container,
    'restic',
    ...args,
  ]);
}

// a signed S3 request to MinIO from inside the dev container
function runS3(method: string, path: string, ...curlArgs: readonly string[]) {
  return runInContainer([
    'curl',
    '-sS',
    '--fail-with-body',
    '-X',
    method,
    '--aws-sigv4',
    'aws:amz:us-east-1:s3',
    '--user',
    `${accessKey}:${secretKey}`,
    ...curlArgs,
    `http://127.0.0.1:9000/${bucket}${path}`,
  ]);
}

beforeAll(async () => {
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(passwordFile, randomBytes(24).toString('hex'), { mode: 0o644 });
  writeFileSync(envFile, `AWS_ACCESS_KEY_ID=${accessKey}\nAWS_SECRET_ACCESS_KEY=${secretKey}\n`);

  Object.assign(process.env, BACKUP_ENV);

  // impd reads its backup env at start; MinIO joins the new container
  await runDevScript('reboot');
  await runCommand(['docker', 'rm', '-f', minio]);

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    minio,
    '--network',
    `container:${instance.container}`,
    '--tmpfs',
    '/data:size=2g,uid=65532',
    '-e',
    `MINIO_ROOT_USER=${accessKey}`,
    '-e',
    `MINIO_ROOT_PASSWORD=${secretKey}`,
    MINIO_IMAGE,
    'server',
    '/data',
    '--address',
    '127.0.0.1:9000',
  ]);

  await waitFor('MinIO to answer', async () => {
    const result = await runInContainer([
      'curl',
      '-sf',
      'http://127.0.0.1:9000/minio/health/ready',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
  });

  await runS3('PUT', '');
}, 600_000);

afterAll(async () => {
  await runCommand(['docker', 'rm', '-f', minio]);

  for (const key of Object.keys(BACKUP_ENV)) {
    delete process.env[key];
  }

  // the instance goes back to no backups
  await runDevScript('reboot');

  rmSync(secretsDir, { recursive: true, force: true });
}, 600_000);

const runs: { first?: z.infer<typeof BackupRunSchema> } = {};

test('a run backs up a running imp mid-write, a stopped imp and a checkpoint', async () => {
  await createImp(source, '--image', TINY, '--memory', '256');
  await holdImp(source);
  await writeGuestFile(source, '/root/f', 'v1');
  await runImp('checkpoint', source, 'cp1');
  await writeGuestFile(source, '/root/f', 'v2');
  await createImp(idle, '--image', TINY, '--memory', '256');
  await writeGuestFile(idle, '/root/f', 'idle');
  await runImp('stop', idle);

  // a writer that never stops for long: the freeze lands among its writes
  await runShellInImp(
    source,
    'echo \'i=0; while :; do echo "line $i" >> /root/log; i=$((i+1)); sleep 0.01; done\' > /root/writer.sh && setsid sh /root/writer.sh >/dev/null 2>&1 &',
  );

  const started = Date.now();

  const run = await runBackup();

  writeMetric('backupFirstMs', Date.now() - started);
  writeMetric('backupFirstAddedMiB', Math.round(run.dataAddedBytes / 1_048_576));

  // the bracket keeps pkill from matching the shell that runs it
  await runShellInImp(source, 'pkill -f "[w]riter.sh" || true');

  expect(run.imps).toContain(source);
  expect(run.imps).toContain(idle);
  expect(run.skipped).toEqual([]);

  runs.first = run;
});

test('the next run of unchanged disks adds next to nothing', async () => {
  const started = Date.now();

  const run = await runBackup();

  writeMetric('backupNextMs', Date.now() - started);
  writeMetric('backupNextAddedMiB', Math.round(run.dataAddedBytes / 1_048_576));

  expect(run.dataAddedBytes).toBeLessThan((runs.first?.dataAddedBytes ?? 0) / 4);
});

test('a restore brings the imp back stopped, then its checkpoint restores too', async () => {
  registerImp(copy);

  const started = Date.now();

  await runImp('backup', 'restore', source, '--as', copy);

  writeMetric('backupRestoreMs', Date.now() - started);

  const restoredState = await readState(copy);

  expect(restoredState).toBe('stopped');

  await runImp('start', copy);
  await waitForExec(copy);

  const restoredFile = await readGuestFile(copy, '/root/f');

  expect(restoredFile).toBe('v2');

  // the guest's own journal makes the log whole: the last line is complete
  const last = await runShellInImp(copy, 'tail -n 1 /root/log');

  expect(last).toMatch(/^line \d+$/v);

  const checkpoints = await listCheckpoints(copy);

  expect(checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['cp1']);

  await runImp('restore', copy, 'cp1');
  await waitForExec(copy);

  const checkpointFile = await readGuestFile(copy, '/root/f');

  expect(checkpointFile).toBe('v1');
});

test('restore --all refuses a host with imps, and --merge names the clash', async () => {
  const all = await tryImp(['backup', 'restore', '--all']);

  expect(all.exitCode).not.toBe(0);
  expect(all.stderr).toContain('restore --all --merge');

  const merged = await tryImp(['backup', 'restore', '--all', '--merge']);

  expect(merged.exitCode).not.toBe(0);

  // the newest point may hold more of the suite's imps: the first clash is named
  expect(merged.stderr).toMatch(new RegExp(`an imp named ${prefix}[a-z0-9\\-]+ exists`, 'v'));
});

test('a point that survived forget and prune restores; a forgotten one is gone', async () => {
  const before = await readStatus();

  const firstTime = before.points[0]?.time ?? new Date();

  // the schedule's first run prunes
  await waitFor(
    'the scheduled prune',
    async () => {
      const status = await readStatus();

      if (status.lastPruneAt === null) {
        throw new Error('no prune yet');
      }
    },
    { timeoutMs: (INTERVAL_S + 120) * 1000 },
  );

  const status = await readStatus();

  writeMetric('backupPointsAfterPrune', status.points.length);

  // every run so far fell in one hour: forget keeps only the newest
  expect(status.points.at(-1)?.imps).toContain(idle);

  registerImp(`${prefix}idle2`);

  await runImp('backup', 'restore', idle, '--as', `${prefix}idle2`);

  const survivorState = await readState(`${prefix}idle2`);

  expect(survivorState).toBe('stopped');

  const early = new Date(firstTime.getTime() - 1000).toISOString();

  const gone = await tryImp(['backup', 'restore', idle, '--as', `${prefix}idle9`, '--at', early]);

  expect(gone.exitCode).not.toBe(0);
  expect(gone.stderr).toContain('not found');
});

test('a stale lock in the repository does not block a restore', async () => {
  // `check` takes restic's exclusive lock and, throttled to 16 KiB/s, holds
  // it for minutes on this repository; a SIGKILL leaves it behind
  await runCommand([
    'docker',
    'exec',
    '-d',
    '--env-file',
    envFile,
    '-e',
    `RESTIC_REPOSITORY=${repository}`,
    '-e',
    `RESTIC_PASSWORD_FILE=${passwordInContainer}`,
    instance.container,
    'restic',
    '--limit-download',
    '16',
    'check',
    '--read-data',
  ]);

  await waitFor('restic check to take its lock', async () => {
    const locks = await runRestic('list', 'locks', '--no-lock');

    if (locks.stdout.trim() === '') {
      throw new Error('no lock yet');
    }
  });

  await runInContainer(['pkill', '-9', '-f', 'restic --limit-download']);

  const locks = await runRestic('list', 'locks', '--no-lock');

  const lockId = locks.stdout.trim().split('\n')[0] ?? '';

  const lock = await runRestic('cat', 'lock', lockId, '--no-lock');

  expect(lock.stdout).toContain('"exclusive": true');

  registerImp(`${prefix}idle3`);

  await runImp('backup', 'restore', idle, '--as', `${prefix}idle3`);

  const unlockedState = await readState(`${prefix}idle3`);

  expect(unlockedState).toBe('stopped');
});

test('a corrupted pack fails the check, loudly', async () => {
  const listing = await runS3('GET', '?list-type=2&prefix=data/');

  const key = /<Key>(?<key>data\/[^<]+)<\/Key>/v.exec(listing.stdout)?.groups?.['key'];

  expect(key).toBeDefined();

  const garbage = randomBytes(4096).toString('hex');

  const put = await runS3('PUT', `/${key ?? ''}`, '--data-binary', garbage);

  expect(put.exitCode).toBe(0);

  const check = await tryImp(['backup', 'check', '--subset', '100%']);

  expect(check.exitCode).not.toBe(0);

  const status = await readStatus();

  expect(status.lastCheck?.error).toBeDefined();
});
