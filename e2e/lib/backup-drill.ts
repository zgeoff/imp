import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { runImp } from './imp-cli';
import { REPO_ROOT, instance, runChecked, runCommand, runInContainer } from './instance';
import { waitFor } from './wait-for';

// The restore drill's repository (docs/architecture/storage/backups.md): MinIO in a
// container that shares the dev instance's network, so impd reaches it on
// 127.0.0.1:9000, pinned by digest.
const MINIO_IMAGE =
  'cgr.dev/chainguard/minio@sha256:0f95aa412a12351a95bb43c3b54b66440eb0aa022bb3f3458942678a489e915b';

const BUCKET = 'imp-e2e';
const BACKUP_REPOSITORY = `s3:http://127.0.0.1:9000/${BUCKET}`;

export interface BackupSecrets {
  // under the repo, which the dev container mounts at /src
  readonly dir: string;
  readonly envFile: string;
  readonly passwordInContainer: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

// impd's backup settings for the drill: the schedule runs every `intervalS`
export function buildBackupEnv(
  secrets: Readonly<BackupSecrets>,
  intervalS: number,
): Readonly<Record<string, string>> {
  return {
    IMP_BACKUP_REPOSITORY: BACKUP_REPOSITORY,
    IMP_BACKUP_PASSWORD_FILE: secrets.passwordInContainer,
    IMP_BACKUP_INTERVAL_S: String(intervalS),
    IMP_BACKUP_MEMORY_MIB: '256',
    IMP_DEV_BACKUP_ENV_FILE: secrets.envFile,
  };
}

// the first data pack's key in an S3 ListObjectsV2 answer, or undefined
export function findPackKey(listing: string): string | undefined {
  return /<Key>(?<key>data\/[^<]+)<\/Key>/v.exec(listing)?.groups?.['key'];
}

const SkipSchema = z.object({ name: z.string(), reason: z.string() });

const BackupRunSchema = z.object({
  snapshotId: z.string(),
  imps: z.array(z.string()),
  skipped: z.array(SkipSchema),
  excluded: z.array(SkipSchema),
  dataAddedBytes: z.number(),
  durationMs: z.number(),
});

const PointSchema = z.object({ id: z.string(), time: z.coerce.date(), imps: z.array(z.string()) });
const CheckSchema = z.object({ at: z.coerce.date(), error: z.string().optional() });

const BackupStatusSchema = z.object({
  points: z.array(PointSchema),
  lastPruneAt: z.coerce.date().nullable(),
  lastCheck: CheckSchema.nullable(),
});

// Thin glue over the dev instance and MinIO below.

// Throwaway keys for a throwaway bucket, in a new dir the caller removes.
export async function writeBackupSecrets(): Promise<BackupSecrets> {
  const parent = join(REPO_ROOT, '.cache', 'e2e');

  await mkdir(parent, { recursive: true });

  const dir = await mkdtemp(join(parent, 'backups-'));

  const accessKey = 'e2e-backups';
  const secretKey = randomBytes(18).toString('hex');
  const envFile = join(dir, 'restic.env');
  const passwordFile = join(dir, 'restic-password');

  await writeFile(passwordFile, randomBytes(24).toString('hex'), { mode: 0o644 });
  await writeFile(envFile, `AWS_ACCESS_KEY_ID=${accessKey}\nAWS_SECRET_ACCESS_KEY=${secretKey}\n`);

  return {
    dir,
    envFile,
    passwordInContainer: `/src/${passwordFile.slice(REPO_ROOT.length + 1)}`,
    accessKey,
    secretKey,
  };
}

export function removeBackupSecrets(secrets: Readonly<BackupSecrets>): Promise<void> {
  return rm(secrets.dir, { recursive: true, force: true });
}

function readMinioName(): string {
  return `${instance.container}-minio`;
}

// MinIO in the container's network, with the bucket made; the caller stops
// it with stopMinio, before the instance's next reboot
export async function startMinio(secrets: Readonly<BackupSecrets>): Promise<void> {
  await runCommand(['docker', 'rm', '-f', readMinioName()]);

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    readMinioName(),
    '--network',
    `container:${instance.container}`,
    '--tmpfs',
    '/data:size=2g,uid=65532',
    '-e',
    `MINIO_ROOT_USER=${secrets.accessKey}`,
    '-e',
    `MINIO_ROOT_PASSWORD=${secrets.secretKey}`,
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

  const made = await runS3(secrets, 'PUT', '');

  if (made.exitCode !== 0) {
    throw new Error(`the bucket: ${made.stdout}${made.stderr}`);
  }
}

export async function stopMinio(): Promise<void> {
  await runCommand(['docker', 'rm', '-f', readMinioName()]);
}

// a signed S3 request to MinIO from inside the dev container
export function runS3(
  secrets: Readonly<BackupSecrets>,
  method: string,
  path: string,
  ...curlArgs: readonly string[]
) {
  return runInContainer([
    'curl',
    '-sS',
    '--fail-with-body',
    '-X',
    method,
    '--aws-sigv4',
    'aws:amz:us-east-1:s3',
    '--user',
    `${secrets.accessKey}:${secrets.secretKey}`,
    ...curlArgs,
    `http://127.0.0.1:9000/${BUCKET}${path}`,
  ]);
}

// `docker exec`'s arguments for restic in the dev container, with impd's
// repository and keys
function buildResticExecArgs(
  secrets: Readonly<BackupSecrets>,
  args: readonly string[],
): readonly string[] {
  return [
    '--env-file',
    secrets.envFile,
    '-e',
    `RESTIC_REPOSITORY=${BACKUP_REPOSITORY}`,
    '-e',
    `RESTIC_PASSWORD_FILE=${secrets.passwordInContainer}`,
    instance.container,
    'restic',
    ...args,
  ];
}

export function runRestic(secrets: Readonly<BackupSecrets>, ...args: readonly string[]) {
  return runCommand(['docker', 'exec', ...buildResticExecArgs(secrets, args)]);
}

// in the background, for the caller to kill
export function startRestic(secrets: Readonly<BackupSecrets>, ...args: readonly string[]) {
  return runCommand(['docker', 'exec', '-d', ...buildResticExecArgs(secrets, args)]);
}

export async function runBackup() {
  const stdout = await runImp('backup', 'run', '--json');

  return BackupRunSchema.parse(JSON.parse(stdout));
}

export async function readBackupStatus() {
  const stdout = await runImp('backup', 'ls', '--json');

  return BackupStatusSchema.parse(JSON.parse(stdout));
}
