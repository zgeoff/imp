import { LIB_SCRIPT, getHostImage, runChecked, runCommand } from './instance';
import type { ZfsCommandResult } from './zfs-owner';

// zpool and zfs as root, from the host image, as the data wipe runs
export async function runHostZfs(argv: readonly string[]): Promise<ZfsCommandResult> {
  // scripts/lib.sh knows how the host image builds
  await runChecked(['bash', '-c', 'source "$1" && ensure_host_image', 'bash', LIB_SCRIPT]);

  return runCommand(['docker', 'run', '--rm', '--privileged', getHostImage(), ...argv]);
}
