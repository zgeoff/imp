import { requireImp, runShellInImp } from './imp-cli';
import { runInContainer } from './instance';

export interface CpuStat {
  readonly usageUsec: number;
  readonly throttledUsec: number;
}

// The two counters of a cgroup v2 cpu.stat the cpu suite reads; throws when
// either is missing, as a cgroup without the cpu controller shows.
export function parseCpuStat(text: string): CpuStat {
  const readField = (field: string): number => {
    const value = new RegExp(`^${field} (?<value>\\d+)$`, 'mv').exec(text)?.groups?.['value'];

    if (value === undefined) {
      throw new TypeError(`no ${field} in cpu.stat: ${JSON.stringify(text)}`);
    }

    return Number(value);
  };

  return { usageUsec: readField('usage_usec'), throttledUsec: readField('throttled_usec') };
}

// Thin glue over the host container and a live guest below.

// an imp's own cgroup in the host container
export async function readImpCgroupDir(name: string): Promise<string> {
  const row = await requireImp(name);

  return `/sys/fs/cgroup/imps/${row.id}`;
}

// a file in the host container; throws when it cannot be read
export async function readContainerFile(path: string): Promise<string> {
  const result = await runInContainer(['cat', path]);

  if (result.exitCode !== 0) {
    throw new Error(`cat ${path} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

export interface BusyLoop {
  // the VM's CPU over host wall time, in cores: an upper bound, since a
  // loaded host may give the VM less, never more
  readonly share: number;
  readonly throttledUsec: number;
}

// Runs one busy guest core for `seconds` and measures the VM's cgroup
// across it.
export async function runBusyLoop(name: string, seconds: number): Promise<BusyLoop> {
  const dir = await readImpCgroupDir(name);
  const before = await readContainerFile(`${dir}/cpu.stat`);

  const started = performance.now();

  await runShellInImp(
    name,
    `end=$(($(date +%s) + ${String(seconds)})); while [ "$(date +%s)" -lt "$end" ]; do :; done`,
  );

  const wallUsec = (performance.now() - started) * 1000;

  const after = await readContainerFile(`${dir}/cpu.stat`);

  const statBefore = parseCpuStat(before);
  const statAfter = parseCpuStat(after);

  return {
    share: (statAfter.usageUsec - statBefore.usageUsec) / wallUsec,
    throttledUsec: statAfter.throttledUsec - statBefore.throttledUsec,
  };
}
