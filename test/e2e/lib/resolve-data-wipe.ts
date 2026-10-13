import { REPO_ROOT } from './instance';
import { runHostZfs } from './run-host-zfs';
import { resolveWipeTarget } from './wipe-target';
import type { WipeTarget } from './wipe-target';

// the wipe's target for a data dir, as this run's instances store it; on
// ZFS, `zfsRoot` is the root dataset of the instance that owns the dir
export function resolveDataWipe(
  path: string,
  zfsRoot: string | undefined = process.env['IMP_ZFS_ROOT'],
): Promise<WipeTarget | null> {
  return resolveWipeTarget({
    path,
    repoRoot: REPO_ROOT,
    storageBackend: process.env['IMP_STORAGE_BACKEND'],
    zfsRoot,
    run: runHostZfs,
  });
}
