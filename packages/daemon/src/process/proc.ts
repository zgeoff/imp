import { readFileSync, readdirSync } from 'node:fs';

// The fields of /proc/<pid>/stat after the parenthesised command name, which
// may itself hold spaces and parentheses: [0] is the state (field 3). null
// when the process is gone. `procRoot` is where /proc is mounted.
export function readStatFields(pid: number, procRoot = '/proc'): string[] | null {
  try {
    const stat = readFileSync(`${procRoot}/${String(pid)}/stat`, 'utf8');

    return stat
      .slice(stat.lastIndexOf(')') + 2)
      .trimEnd()
      .split(' ');
  } catch {
    return null;
  }
}

// Every pid /proc lists now.
export function listPids(procRoot = '/proc'): number[] {
  return readdirSync(procRoot)
    .filter((entry) => /^\d+$/v.test(entry))
    .map(Number);
}

// Sends `signal` to `pid`, and passes over a process that is gone already.
export function stopPid(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}
