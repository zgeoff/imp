import { REPO_ROOT } from './instance';
import { runHostZfs } from './run-host-zfs';
import { resolveWipeTarget } from './wipe-target';
import type { WipeTarget } from './wipe-target';

// the wipe's target for a data dir, as this run's instances store it
export function resolveDataWipe(path: string): Promise<WipeTarget | null> {
  return resolveWipeTarget({
    path,
    repoRoot: REPO_ROOT,
    storageBackend: process.env['IMP_STORAGE_BACKEND'],
    zfsRoot: process.env['IMP_ZFS_ROOT'],
    run: runHostZfs,
  });
}
