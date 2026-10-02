import * as z from 'zod';

// how many restore points restic's `forget` keeps in each bucket
export interface BackupKeep {
  readonly hourly: number;
  readonly daily: number;
  readonly weekly: number;
}

export interface BackupConfig {
  // a restic repository: s3:https://host/bucket/prefix, /a/path, rest:…
  readonly repository: string;

  // restic's password; anyone who has it and the repository can read every
  // backup (docs/architecture/backups.md)
  readonly passwordFile: string;
  readonly intervalS: number;
  readonly keep: BackupKeep;

  // restic runs with GOMAXPROCS and GOMEMLIMIT set from these
  readonly cpus: number;
  readonly memoryMib: number;
}

const CountSchema = z.coerce.number().pipe(z.int().positive());
const KEEP_BUCKETS = ['hourly', 'daily', 'weekly'] as const;

const BackupEnvSchema = z.object({
  IMP_BACKUP_REPOSITORY: z.string().optional(),
  IMP_BACKUP_PASSWORD_FILE: z.string().optional(),
  IMP_BACKUP_INTERVAL_S: CountSchema.default(21_600),
  IMP_BACKUP_KEEP: z.string().default('hourly=24,daily=7,weekly=4'),
  IMP_BACKUP_CPUS: CountSchema.default(2),
  IMP_BACKUP_MEMORY_MIB: CountSchema.default(512),
});

// null when no repository is set: impd then takes no backups
export function loadBackupConfig(
  env: Readonly<Record<string, string | undefined>>,
): BackupConfig | null {
  const parsed = BackupEnvSchema.parse(env);

  if (parsed.IMP_BACKUP_REPOSITORY === undefined) {
    return null;
  }

  if (parsed.IMP_BACKUP_PASSWORD_FILE === undefined) {
    throw new Error('IMP_BACKUP_REPOSITORY needs IMP_BACKUP_PASSWORD_FILE');
  }

  return {
    repository: parsed.IMP_BACKUP_REPOSITORY,
    passwordFile: parsed.IMP_BACKUP_PASSWORD_FILE,
    intervalS: parsed.IMP_BACKUP_INTERVAL_S,
    keep: parseBackupKeep(parsed.IMP_BACKUP_KEEP),
    cpus: parsed.IMP_BACKUP_CPUS,
    memoryMib: parsed.IMP_BACKUP_MEMORY_MIB,
  };
}

// hourly=24,daily=7,weekly=4; a bucket left out keeps none
export function parseBackupKeep(value: string): BackupKeep {
  const keep = { hourly: 0, daily: 0, weekly: 0 };

  for (const part of value.split(',')) {
    const [bucket = '', count = ''] = part.trim().split('=');
    const parsed = Number(count);

    if (!isKeepBucket(bucket) || !Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `IMP_BACKUP_KEEP: ${JSON.stringify(part)} is not hourly|daily|weekly=<count>`,
      );
    }

    keep[bucket] = parsed;
  }

  if (keep.hourly + keep.daily + keep.weekly === 0) {
    throw new Error('IMP_BACKUP_KEEP keeps nothing');
  }

  return keep;
}

function isKeepBucket(bucket: string): bucket is (typeof KEEP_BUCKETS)[number] {
  return (KEEP_BUCKETS as readonly string[]).includes(bucket);
}
