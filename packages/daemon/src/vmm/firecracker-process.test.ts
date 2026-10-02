import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSpawnArgv,
  isFirecrackerAlive,
  listFirecrackers,
  readPidFile,
} from './firecracker-process';
import { buildJailerCommand } from './jail';
import { readProcessCgroup } from './process-owner';

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

    // whom it runs as, which a jailed process cannot forge as its argv
    expect(found).toContainEqual({
      pid: child.pid,
      apiSocket,
      owner: { uid: process.getuid?.() ?? 0, cgroup: readProcessCgroup(child.pid) },
    });
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

const JAILER_COMMAND = buildJailerCommand({
  jailerBin: 'jailer',
  firecrackerBin: '/usr/local/bin/firecracker',
  chrootBase: '/var/lib/imp/jail',
  impId: 'imp',
  user: { uid: 900_000, gid: 900_000 },
  apiSocket: 'api.sock',
});

test('the merge wrapper goes before the jailer, so the chroot needs no copy of it', () => {
  expect(buildSpawnArgv(JAILER_COMMAND, null, null)).toEqual(['setsid', ...JAILER_COMMAND]);

  expect(buildSpawnArgv(JAILER_COMMAND, null, 'ksm-exec')).toEqual([
    'setsid',
    'ksm-exec',
    ...JAILER_COMMAND,
  ]);

  expect(buildSpawnArgv(['firecracker', '--api-sock', 'api.sock'], null, 'ksm-exec')).toEqual([
    'setsid',
    'ksm-exec',
    'firecracker',
    '--api-sock',
    'api.sock',
  ]);
});

// /usr/bin/env stands in for ksm-exec: it execs the rest of its argv
test('in a cgroup, the shell records its pid and execs the wrapper and the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-argv-'));

  try {
    const procs = join(dir, 'cgroup.procs');
    const argv = buildSpawnArgv(['echo', '--api-sock', 'api.sock'], procs, '/usr/bin/env');
    const result = Bun.spawnSync(argv);

    expect(result.stdout.toString()).toBe('--api-sock api.sock\n');
    expect(readFileSync(procs, 'utf8').trim()).toBe(String(result.pid));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
