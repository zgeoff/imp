import { buildUnshare } from './build-unshare';

interface RunInNetnsOptions {
  // run by `bash -euo pipefail`
  readonly script: string;

  // added to this process's env
  readonly env: Readonly<Record<string, string>>;

  // a mount namespace too, for a tmpfs /run that `ip netns` can use
  readonly mount: boolean;
}

export interface NetnsRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

// Runs a bash script as root in a fresh network namespace, through a user
// namespace when this process is not root.
export function runInNetns(options: RunInNetnsOptions): NetnsRun {
  const unshare = buildUnshare({ mount: options.mount, uid: process.getuid?.() });

  const result = Bun.spawnSync([...unshare, 'bash', '-euo', 'pipefail', '-c', options.script], {
    env: { ...process.env, ...options.env },
  });

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}
