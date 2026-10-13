import { LIB_SCRIPT, getHostImage, runChecked } from './instance';
import { runHostZfs } from './run-host-zfs';
import type { WipeTarget } from './wipe-target';
import { ZFS_OWNER_FILE, resetZfsRoot } from './zfs-owner';

// Every file in a data dir whose instance is down, but the ZFS owner file,
// which the next wipe still needs to prove the dir; on ZFS, the root dataset
// made anew too. The instance's next start begins from nothing.
export async function removeDataDir(target: Readonly<WipeTarget>): Promise<void> {
  const hostImage = getHostImage();

  // scripts/lib.sh knows how the host image builds
  await runChecked(['bash', '-c', 'source "$1" && ensure_host_image', 'bash', LIB_SCRIPT]);

  // imp.xfs is root-owned, and a stale loop device can outlive the container
  await runChecked([
    'docker',
    'run',
    '--rm',
    '--privileged',
    '-v',
    `${target.dir}:/d`,
    hostImage,
    'bash',
    '-c',
    `for dev in $(losetup -n -O NAME -j /d/imp.xfs 2>/dev/null); do losetup -d "$dev" || true; done; find /d -mindepth 1 ! -path /d/${ZFS_OWNER_FILE} -delete`,
  ]);

  if (target.zfs !== null) {
    await resetZfsRoot(target.zfs, runHostZfs);
  }
}
