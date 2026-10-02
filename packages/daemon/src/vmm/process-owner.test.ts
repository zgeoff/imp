import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessCgroup, readProcessUid, stopProcessOfUid } from './process-owner';

const OWN_UID = process.getuid?.() ?? 0;

test('a process runs as one uid only when its real and effective uids agree', () => {
  const proc = mkdtempSync(join(tmpdir(), 'imp-proc-'));

  const setStatus = (pid: number, uids: string): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), 'status'), `Name:\tfirecracker\nUid:\t${uids}\n`);
  };

  try {
    setStatus(1, '900001\t900001\t900001\t900001');
    setStatus(2, '900001\t0\t0\t0');
    mkdirSync(join(proc, '3'));
    writeFileSync(join(proc, '3', 'cgroup'), '0::/imps/i1\n');

    expect(readProcessUid(1, proc)).toBe(900_001);
    expect(readProcessUid(2, proc)).toBeNull();
    expect(readProcessUid(4, proc)).toBeNull();
    expect(readProcessCgroup(3, proc)).toBe('/imps/i1');
    expect(readProcessCgroup(4, proc)).toBeNull();
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
});

test('a kill reaches a process only while it runs as the uid', async () => {
  const other = Bun.spawn(['sleep', '30']);
  const own = Bun.spawn(['sleep', '30']);

  try {
    // the uid of no process here: the check fails and nothing is sent
    stopProcessOfUid(other.pid, 900_001);
    stopProcessOfUid(own.pid, OWN_UID);

    await own.exited;

    await Promise.race([other.exited, Bun.sleep(100)]);

    expect(own.signalCode).toBe('SIGKILL');
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();

    // gone, and reaped: no error
    stopProcessOfUid(own.pid, OWN_UID);
  } finally {
    other.kill('SIGKILL');
  }
});
