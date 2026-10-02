import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFirecrackerAlive, listFirecrackers, readPidFile } from './firecracker-process';

// A stand-in whose command line reads `firecracker ... --api-sock <socket>`,
// as /proc shows a real one
async function startStandIn(apiSocket: string) {
  const child = Bun.spawn([
    'bash',
    '-c',
    `exec -a firecracker bash -c 'sleep 30; true' x --api-sock "$0"`,
    apiSocket,
  ]);

  const deadline = Date.now() + 10_000;

  // the socket is in bash's own command line before the exec renames it, so
  // wait for the name too
  while (!isFirecrackerAlive(child.pid, apiSocket) || !isRenamed(child.pid)) {
    if (Date.now() > deadline) {
      throw new Error('the stand-in never started');
    }

    await Bun.sleep(1);
  }

  return child;
}

function isRenamed(pid: number): boolean {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').startsWith('firecracker\0');
  } catch {
    return false;
  }
}

test('/proc shows every live firecracker with the socket it serves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-'));
  const apiSocket = join(dir, 'api.sock');

  const child = await startStandIn(apiSocket);

  try {
    const found = listFirecrackers();

    expect(found).toContainEqual({ pid: child.pid, apiSocket });
  } finally {
    child.kill('SIGKILL');

    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pid file reads as its pid, and anything else as none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-'));
  const pidFile = join(dir, 'pid');

  try {
    const missing = readPidFile(pidFile);

    writeFileSync(pidFile, '4242\n');

    const written = readPidFile(pidFile);

    writeFileSync(pidFile, 'half');

    const broken = readPidFile(pidFile);

    expect([missing, written, broken]).toEqual([null, 4242, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
