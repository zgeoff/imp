import { closeSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { readProcessCgroup, readProcessUid } from './process-owner';
import { readRegularFile, setupLogFile, writeRegularFile } from './vm-files';

// Who runs a Firecracker, by what a jailed process cannot change: its uid
// (null when real and effective differ) and its cgroup.
export interface VmOwner {
  readonly uid: number | null;
  readonly cgroup: string | null;
}

// a live Firecracker, by the API socket its argv names
export interface FoundVm {
  readonly pid: number;
  readonly apiSocket: string;
  readonly owner: VmOwner;
}

// root in the container: an unjailed Firecracker runs as impd does
const IMPD_UID = process.getuid?.() ?? 0;

// Imp `impId`'s VM by what no jail can forge: it runs as impd (unjailed), as
// the imp's own jail uid, or in the imp's cgroup. With no record, and so no
// jail uid, only the first and the last.
export function isImpVm(owner: VmOwner, impId: string, jailUid: number | null): boolean {
  return (
    owner.uid === IMPD_UID ||
    (jailUid !== null && owner.uid === jailUid) ||
    owner.cgroup === `/imps/${impId}`
  );
}

export interface FirecrackerPaths {
  readonly apiSocket: string;
  readonly vsockSocket: string;
  readonly logFile: string;
  readonly pidFile: string;
}

const SOCKET_WAIT_MS = 3000;

// Starts `command`, Firecracker or the jailer that execs it, detached (setsid)
// so it outlives an impd restart, and waits for its API socket. With
// `cgroupProcs` it joins that cgroup before the exec.
export async function startFirecracker(
  command: readonly string[],
  paths: Readonly<FirecrackerPaths>,
  cgroupProcs: string | null = null,
) {
  rmSync(paths.apiSocket, { force: true });
  rmSync(paths.vsockSocket, { force: true });

  const log = setupLogFile(paths.logFile);

  // setsid and exec keep the pid: this process is not a group leader, so no
  // fork; the jailer execs Firecracker in place too
  const argv =
    cgroupProcs === null
      ? ['setsid', ...command]
      : ['sh', '-c', 'echo $$ > "$1" && shift && exec setsid "$@"', 'sh', cgroupProcs, ...command];

  const child = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: log,
    stderr: log,
  });

  closeSync(log);

  child.unref();

  writeRegularFile(paths.pidFile, `${String(child.pid)}\n`);

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
    return readRegularFile(logFile).trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

// The pid a start wrote, or null without a readable file. impd can die
// before it writes one: listFirecrackers finds those.
export function readPidFile(pidFile: string): number | null {
  try {
    const pid = Number(readRegularFile(pidFile).trim());

    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Every live Firecracker in this process's PID namespace, by the API socket
// its /proc/<pid>/cmdline names. A jailed process can name any socket there:
// its owner says whose it is.
export function listFirecrackers(): FoundVm[] {
  const found: FoundVm[] = [];

  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    const pid = Number(entry);
    const argv = readCommandLine(pid);
    const flag = argv.indexOf('--api-sock');
    const apiSocket = argv[flag + 1];

    if (
      basename(argv[0] ?? '') === 'firecracker' &&
      flag !== -1 &&
      apiSocket !== undefined &&
      isFirecrackerAlive(pid, apiSocket)
    ) {
      found.push({ pid, apiSocket, owner: readVmOwner(pid) });
    }
  }

  return found;
}

export function readVmOwner(pid: number): VmOwner {
  return { uid: readProcessUid(pid), cgroup: readProcessCgroup(pid) };
}

// empty when the process is gone or not ours to read
function readCommandLine(pid: number): string[] {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0');
  } catch {
    return [];
  }
}

// Firecracker's own command, unjailed
export function buildFirecrackerCommand(bin: string, apiSocket: string): readonly string[] {
  return [bin, '--api-sock', apiSocket];
}

// a jailed Firecracker runs as `/firecracker --id <id> ...` (jail.ts)
export function isJailedFirecracker(pid: number): boolean {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8')
      .split('\0')
      .includes('--id');
  } catch {
    return false;
  }
}
