import { closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPidfdLibc } from '../process/libc';
import { stopPid } from '../process/proc';

// What /proc says about who runs a process: its uids and its cgroup. A jailed
// process can rewrite its argv, but not these.

interface ProcessUids {
  readonly real: number;
  readonly effective: number;
}

// the real and effective uid; null when the process is gone
function readProcessUids(pid: number, procRoot = '/proc'): ProcessUids | null {
  try {
    const status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    const uids = /^Uid:\s+(?<real>\d+)\s+(?<effective>\d+)/m.exec(status)?.groups;

    return uids === undefined
      ? null
      : { real: Number(uids['real']), effective: Number(uids['effective']) };
  } catch {
    return null;
  }
}

// the one uid a process runs as, real and effective; null when they differ
// or the process is gone
export function readProcessUid(pid: number, procRoot = '/proc'): number | null {
  const uids = readProcessUids(pid, procRoot);

  return uids !== null && uids.real === uids.effective ? uids.real : null;
}

// the cgroup v2 path of a process, such as /imps/<id>; null when gone
export function readProcessCgroup(pid: number, procRoot = '/proc'): string | null {
  try {
    const text = readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8');

    return text.trim().replace(/^0::/, '');
  } catch {
    return null;
  }
}

// whether `pid` runs as `uid`, by its real or its effective uid
export function isProcessOfUid(pid: number, uid: number): boolean {
  const uids = readProcessUids(pid);

  return uids !== null && (uids.real === uid || uids.effective === uid);
}

const SIGKILL = 9;

interface Pidfd {
  readonly open: (pid: number) => number;
  readonly sendSignal: (fd: number, signal: number) => number;
}

// glibc's pidfd wrappers (2.36+); null where they or the syscalls are missing
function loadPidfd(): Pidfd | null {
  const libc = getPidfdLibc();

  if (libc === null) {
    return null;
  }

  try {
    const pidfd: Pidfd = {
      open: (pid) => libc.pidfd_open(pid, 0),
      sendSignal: (fd, signal) => libc.pidfd_send_signal(fd, signal, null, 0),
    };

    // a kernel before 5.3 has the wrapper but not the syscall
    const own = pidfd.open(process.pid);

    if (own < 0) {
      return null;
    }

    closeSync(own);

    return pidfd;
  } catch {
    return null;
  }
}

let pidfd: Pidfd | null | undefined;

// SIGKILL to `pid` only while it runs as `uid`, through a pidfd: the uid read
// once it is open is that of the process the signal reaches. Without pidfd,
// the uid is read just before kill(), and a reused pid can still be hit.
export function stopProcessOfUid(pid: number, uid: number): void {
  pidfd ??= loadPidfd();

  if (pidfd === null) {
    if (isProcessOfUid(pid, uid)) {
      stopPid(pid);
    }

    return;
  }

  const fd = pidfd.open(pid);

  // gone already
  if (fd < 0) {
    return;
  }

  try {
    if (isProcessOfUid(pid, uid)) {
      pidfd.sendSignal(fd, SIGKILL);
    }
  } finally {
    closeSync(fd);
  }
}
