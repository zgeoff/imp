import * as z from 'zod';
import { runCommand } from '../process/run-command';
import type { CommandResult } from '../process/run-command';
import type { BackupConfig, BackupKeep } from './backup-config';

// runCommand in impd; a fake restic in tests
export type ResticRunner = (
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

// every impd snapshot carries it, so forget never touches anything else in a
// shared repository
export const BACKUP_TAG = 'imp-backup';

// restic's hostname for impd's snapshots: the container's own changes with
// every container, which would split retention into groups
const RESTIC_HOST = 'impd';

// `restic cat config` exits 10 when the repository does not exist yet
const NO_REPOSITORY_EXIT = 10;

const SnapshotSchema = z.object({
  id: z.string(),
  time: z.coerce.date(),
  paths: z.array(z.string()),
  tags: z.array(z.string()).nullish(),
});

const SummarySchema = z.object({
  message_type: z.literal('summary'),
  snapshot_id: z.string(),
  files_new: z.number(),
  files_changed: z.number(),
  files_unmodified: z.number(),
  data_added: z.number(),
});

export interface ResticSnapshot {
  readonly id: string;
  readonly time: Date;
  readonly paths: readonly string[];
  readonly tags: readonly string[];
}

export interface ResticSummary {
  readonly snapshotId: string;
  readonly filesNew: number;
  readonly filesChanged: number;
  readonly filesUnmodified: number;
  readonly dataAddedBytes: number;
}

export interface Restic {
  // creates the repository the first time
  readonly setupRepository: () => Promise<void>;
  readonly backup: (dir: string, tags: readonly string[]) => Promise<ResticSummary>;
  readonly forget: (keep: BackupKeep) => Promise<void>;
  readonly prune: () => Promise<void>;
  readonly check: (readDataSubset: string) => Promise<void>;

  // removes only stale locks: those of a dead restic on this host, or old ones
  readonly unlock: () => Promise<void>;
  readonly listSnapshots: () => Promise<ResticSnapshot[]>;
  readonly dump: (snapshotId: string, path: string) => Promise<string>;

  // `<snapshot>:<dir>` into target, sparse, limited to the include patterns
  readonly restore: (
    snapshotId: string,
    dir: string,
    target: string,
    includes: readonly string[],
  ) => Promise<void>;
}

interface ResticDeps {
  readonly config: BackupConfig;

  // restic's local cache, which saves reading index and tree data back
  readonly cacheDir: string;
  readonly run?: ResticRunner;
}

export function createRestic(deps: ResticDeps): Restic {
  const run = deps.run ?? ((argv, env) => runCommand(argv, { env }));

  // Only what restic needs: impd's env holds TAILSCALE_AUTHKEY. The password
  // stays in its file and never reaches an argv or a log line.
  const env: Record<string, string> = {
    ...pickEnv(process.env),
    RESTIC_REPOSITORY: deps.config.repository,
    RESTIC_PASSWORD_FILE: deps.config.passwordFile,
    RESTIC_CACHE_DIR: deps.cacheDir,
    GOMAXPROCS: String(deps.config.cpus),
    GOMEMLIMIT: `${String(deps.config.memoryMib)}MiB`,
  };

  // lowest CPU and IO priority, so awake imps come first
  const runRestic = (args: readonly string[]): Promise<CommandResult> =>
    run(['nice', '-n', '19', 'ionice', '-c', '3', 'restic', ...args], env);

  const runChecked = async (args: readonly string[]): Promise<string> => {
    const result = await runRestic(args);

    if (result.exitCode !== 0) {
      throw new Error(
        `restic ${args[0] ?? ''} exited ${String(result.exitCode)}: ${readLastLine(result.stderr || result.stdout)}`,
      );
    }

    return result.stdout;
  };

  return {
    setupRepository: async () => {
      const found = await runRestic(['cat', 'config', '--quiet']);

      if (found.exitCode === NO_REPOSITORY_EXIT) {
        await runChecked(['init', '--quiet']);
      } else if (found.exitCode !== 0) {
        throw new Error(
          `restic cat config exited ${String(found.exitCode)}: ${readLastLine(found.stderr)}`,
        );
      }
    },

    backup: async (dir, tags) => {
      const tagArgs = [BACKUP_TAG, ...tags].flatMap((tag) => ['--tag', tag]);

      const stdout = await runChecked(['backup', '--json', '--host', RESTIC_HOST, ...tagArgs, dir]);

      return parseBackupSummary(stdout);
    },

    forget: async (keep) => {
      await runChecked([
        'forget',
        '--quiet',
        '--tag',
        BACKUP_TAG,
        '--group-by',
        'host',
        '--keep-hourly',
        String(keep.hourly),
        '--keep-daily',
        String(keep.daily),
        '--keep-weekly',
        String(keep.weekly),
      ]);
    },

    prune: async () => {
      await runChecked(['prune', '--quiet']);
    },

    check: async (readDataSubset) => {
      await runChecked(['check', '--quiet', `--read-data-subset=${readDataSubset}`]);
    },

    unlock: async () => {
      await runChecked(['unlock', '--quiet']);
    },

    listSnapshots: async () => {
      const stdout = await runChecked(['snapshots', '--json', '--tag', BACKUP_TAG]);

      return parseSnapshots(stdout);
    },

    dump: (snapshotId, path) => runChecked(['dump', '--quiet', snapshotId, path]),

    restore: async (snapshotId, dir, target, includes) => {
      await runChecked([
        'restore',
        '--quiet',
        '--sparse',
        '--target',
        target,
        ...includes.flatMap((pattern) => ['--include', pattern]),
        `${snapshotId}:${dir}`,
      ]);
    },
  };
}

// `restic snapshots --json`, oldest first
export function parseSnapshots(stdout: string): ResticSnapshot[] {
  const parsed = z.array(SnapshotSchema).parse(JSON.parse(stdout || '[]'));

  return parsed
    .map((snapshot) => ({
      id: snapshot.id,
      time: snapshot.time,
      paths: snapshot.paths,
      tags: snapshot.tags ?? [],
    }))
    .toSorted((a, b) => a.time.getTime() - b.time.getTime());
}

// the last line of `restic backup --json`, its summary
export function parseBackupSummary(stdout: string): ResticSummary {
  const lines = stdout.trim().split('\n');
  const summary = SummarySchema.parse(JSON.parse(lines.at(-1) ?? '{}'));

  return {
    snapshotId: summary.snapshot_id,
    filesNew: summary.files_new,
    filesChanged: summary.files_changed,
    filesUnmodified: summary.files_unmodified,
    dataAddedBytes: summary.data_added,
  };
}

// the parts of impd's env restic reads: its home, and the S3 or B2 credentials
const PASSED_ENV = /^(?:PATH|HOME|TMPDIR|AWS_[A-Z_]+|B2_[A-Z_]+)$/v;

function pickEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => PASSED_ENV.test(entry[0]) && entry[1] !== undefined,
    ),
  );
}

function readLastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}
