import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as z from 'zod';

// What scripts/zfs-host-test.sh writes into the data dir once it has made
// the pool: the pool, the root dataset impd runs on, and the pool's one vdev.
export const ZFS_OWNER_FILE = 'imp-e2e-zfs-owner';

const ZfsOwnerSchema = z.object({
  pool: z.string().min(1),
  root: z.string().min(1),
  vdev: z.string().min(1),
});

export type ZfsOwner = z.infer<typeof ZfsOwnerSchema>;

export interface ZfsCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// runs zpool or zfs as root against the host's pools
export type RunZfsCommand = (argv: readonly string[]) => Promise<ZfsCommandResult>;

export interface ZfsOwnerOptions {
  // the instance's data dir, resolved
  readonly dataDir: string;

  // IMP_ZFS_ROOT, the root dataset this run's impd runs on
  readonly zfsRoot: string | undefined;
  readonly run: RunZfsCommand;
}

function readOwnerFile(dataDir: string): ZfsOwner | null {
  try {
    const text = readFileSync(join(dataDir, ZFS_OWNER_FILE), 'utf8');
    const parsed = ZfsOwnerSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function resolveDir(path: string): string | null {
  return existsSync(path) ? realpathSync(path) : null;
}

// The pool and root a data dir provably belongs to, or null: the owner file's
// root is IMP_ZFS_ROOT, in its pool, whose listed vdev sits beside the data
// dir. Then the pool, and all in it, is the run's.
export async function readZfsOwner(options: Readonly<ZfsOwnerOptions>): Promise<ZfsOwner | null> {
  const owner = readOwnerFile(options.dataDir);

  if (owner === null || owner.root !== options.zfsRoot) {
    return null;
  }

  if (!owner.root.startsWith(`${owner.pool}/`)) {
    return null;
  }

  const vdevDir = resolveDir(dirname(owner.vdev));

  if (vdevDir === null || vdevDir !== resolveDir(dirname(options.dataDir))) {
    return null;
  }

  const status = await options.run(['zpool', 'status', '-P', owner.pool]);

  if (status.exitCode !== 0) {
    return null;
  }

  const vdevs = status.stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]);

  return vdevs.includes(owner.vdev) ? owner : null;
}

async function runZfsChecked(run: RunZfsCommand, argv: readonly string[]): Promise<void> {
  const result = await run(argv);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
}

// Takes the root dataset back to empty: every dataset, snapshot and clone
// under it goes. Clones live in their origin's pool, which the owner proof
// showed is this run's, so -R reaches nothing another run made.
export async function resetZfsRoot(owner: Readonly<ZfsOwner>, run: RunZfsCommand): Promise<void> {
  await runZfsChecked(run, ['zfs', 'destroy', '-R', owner.root]);
  await runZfsChecked(run, ['zfs', 'create', '-o', 'mountpoint=legacy', owner.root]);
}
