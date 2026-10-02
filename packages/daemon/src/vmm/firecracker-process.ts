import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export interface FirecrackerPaths {
  readonly apiSocket: string;
  readonly vsockSocket: string;
  readonly logFile: string;
  readonly pidFile: string;
}

const SOCKET_WAIT_MS = 3000;

// Starts Firecracker detached (setsid), so it outlives an impd restart, and
// waits for its API socket; its output goes to `logFile`. With `cgroupProcs`
// it joins that cgroup before the exec, so no thread runs outside.
export async function startFirecracker(
  bin: string,
  paths: Readonly<FirecrackerPaths>,
  cgroupProcs: string | null = null,
) {
  rmSync(paths.apiSocket, { force: true });
  rmSync(paths.vsockSocket, { force: true });

  const log = openSync(paths.logFile, 'a');

  // setsid and exec keep the pid: this process is not a group leader, so no
  // fork
  const argv =
    cgroupProcs === null
      ? ['setsid', bin, '--api-sock', paths.apiSocket]
      : [
          'sh',
          '-c',
          'echo $$ > "$1" && exec setsid "$2" --api-sock "$3"',
          'sh',
          cgroupProcs,
          bin,
          paths.apiSocket,
        ];

  const child = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: log,
    stderr: log,
  });

  closeSync(log);

  child.unref();

  writeFileSync(paths.pidFile, `${String(child.pid)}\n`);

  const deadline = Date.now() + SOCKET_WAIT_MS;

  while (!existsSync(paths.apiSocket)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      stopProcess(child.pid);

      throw new Error(
        `firecracker did not open its API socket (exit ${String(child.exitCode)}): ${readLogTail(paths.logFile)}`,
      );
    }

    await Bun.sleep(2);
  }

  return child.pid;
}

// True when `pid` is a live Firecracker serving `apiSocket`; a recycled pid
// fails the cmdline check.
export function isFirecrackerAlive(pid: number, apiSocket: string): boolean {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const cmdline = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0');

    // the state field follows the parenthesised command name
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);

    return state !== 'Z' && state !== 'X' && cmdline.includes(apiSocket);
  } catch {
    return false;
  }
}

export function stopProcess(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

// Resolves true once the process is gone, false at the timeout.
export async function waitForExit(
  pid: number,
  apiSocket: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (isFirecrackerAlive(pid, apiSocket)) {
    if (Date.now() > deadline) {
      return false;
    }

    await Bun.sleep(10);
  }

  return true;
}

export function readLogTail(logFile: string, lines = 20): string {
  try {
    return readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}
