import type { CpuCgroups } from '../vmm/cpu-cgroups';

// what the record and the log say when the cgroup's memory limit killed the VM
export const OOM_KILL_TRIGGER = 'its memory limit killed firecracker';

// Whether the kernel OOM-killed in the imp's cgroup since this call, for a
// sleep or a wake that failed: a cgroup that a busy rmdir kept still counts
// an older kill, so a count alone does not say. False without the cgroup.
export function startOomWatch(
  cgroups: Pick<CpuCgroups, 'readOomKills'>,
  impId: string,
): () => boolean {
  const before = cgroups.readOomKills(impId) ?? 0;

  return () => (cgroups.readOomKills(impId) ?? 0) > before;
}
