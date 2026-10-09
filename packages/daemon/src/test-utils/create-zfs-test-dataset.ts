import { mkdtempSync, rmdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runCommand } from '../process/run-command';
import type { CommandRunner } from '../storage/zfs/zfs-commands';

export interface ZfsTestDatasetOptions {
  // the run's pool dataset and its mount dir (readZfsTestPool)
  readonly parent: string;
  readonly parentDir: string;
  readonly run?: CommandRunner;
}

export interface ZfsTestDataset {
  readonly root: string;
  readonly dataDir: string;
}

async function runOrThrow(run: CommandRunner, argv: readonly string[]): Promise<void> {
  const result = await run(argv);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
}

// A fresh dataset of this run under `parent`, legacy-mounted on a new dir
// under `parentDir`, as host/scripts/setup-storage.sh mounts impd's root.
// Each release goes into `stack` right after its acquisition.
export async function createZfsTestDataset(
  stack: Readonly<AsyncDisposableStack>,
  options: ZfsTestDatasetOptions,
): Promise<ZfsTestDataset> {
  const run = options.run ?? runCommand;

  // the new dir names the dataset; a dataset of that name that `zfs list`
  // already shows belongs to someone else, and is refused untouched
  const dataDir = mkdtempSync(join(options.parentDir, 'dataset-'));

  stack.defer(() => {
    rmdirSync(dataDir);
  });

  const root = `${options.parent}/${basename(dataDir)}`;

  const listed = await run(['zfs', 'list', '-H', '-o', 'name', root]);

  if (listed.exitCode === 0) {
    throw new Error(`zfs: ${root} exists already, and this run did not make it`);
  }

  await runOrThrow(run, ['zfs', 'create', '-o', 'mountpoint=legacy', root]);

  stack.defer(() => runOrThrow(run, ['zfs', 'destroy', '-R', root]));

  await runOrThrow(run, ['mount', '-t', 'zfs', root, dataDir]);

  stack.defer(() => runOrThrow(run, ['umount', '-R', dataDir]));

  return { root, dataDir };
}
