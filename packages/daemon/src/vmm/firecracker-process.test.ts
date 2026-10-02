import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  while (!isFirecrackerAlive(child.pid, apiSocket)) {
    if (Date.now() > deadline) {
      throw new Error('the stand-in never started');
    }

    await Bun.sleep(1);
  }

  return child;
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
