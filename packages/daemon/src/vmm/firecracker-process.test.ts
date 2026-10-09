import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { startStubFirecrackerProcess } from '../test-utils/start-stub-firecracker-process';
import {
  buildFirecrackerCommand,
  buildSpawnArgv,
  isFirecrackerAlive,
  isImpVm,
  isJailedFirecracker,
  listFirecrackers,
  readLogTail,
  readPidFile,
  readVmOwner,
  startFirecracker,
  stopProcess,
  waitForExit,
} from './firecracker-process';
import { buildJailerCommand } from './jail';
import { readProcessCgroup } from './process-owner';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fc-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('#listFirecrackers finds a live firecracker with the socket it serves and its owner', async () => {
  const ctx = setupTest();
  const apiSocket = join(ctx.dir, 'api.sock');

  const child = await startStubFirecrackerProcess(apiSocket);

  const found = listFirecrackers();

  // whom it runs as, which a jailed process cannot forge as its argv
  expect(found).toContainEqual({
    pid: child.pid,
    apiSocket,
    owner: { uid: process.getuid?.() ?? 0, cgroup: readProcessCgroup(child.pid) },
  });
});

test('#isFirecrackerAlive finds a live firecracker serving its socket in the host /proc by default', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(isFirecrackerAlive(child.pid, join(ctx.dir, 'api.sock'))).toBeTrue();
});

test('#isFirecrackerAlive finds a running firecracker serving its socket', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.dir, 'proc', '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.dir, 'proc', '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  expect(isFirecrackerAlive(42, '/run/api.sock', join(ctx.dir, 'proc'))).toBeTrue();
});

test('#isFirecrackerAlive finds no firecracker serving another socket under the pid', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.dir, 'proc', '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');

  writeFileSync(
    join(ctx.dir, 'proc', '42', 'cmdline'),
    'firecracker\0--api-sock\0/run/other.sock\0',
  );

  expect(isFirecrackerAlive(42, '/run/api.sock', join(ctx.dir, 'proc'))).toBeFalse();
});

test.each([
  ['a zombie', 'Z'],
  ['dead', 'X'],
])('#isFirecrackerAlive finds no firecracker that is %s', (_label, state) => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.dir, 'proc', '42', 'stat'), `42 (firecracker) ${state} 1 42 42 0 -1`);
  writeFileSync(join(ctx.dir, 'proc', '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  expect(isFirecrackerAlive(42, '/run/api.sock', join(ctx.dir, 'proc'))).toBeFalse();
});

test('#isFirecrackerAlive reads the state past a command name with spaces and parentheses', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'proc', '42'), { recursive: true });
  writeFileSync(join(ctx.dir, 'proc', '42', 'stat'), '42 (fc (Z) x) S 1 42 42 0 -1');
  writeFileSync(join(ctx.dir, 'proc', '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  expect(isFirecrackerAlive(42, '/run/api.sock', join(ctx.dir, 'proc'))).toBeTrue();
});

test('#isFirecrackerAlive finds no firecracker once its pid is gone', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'proc'));

  expect(isFirecrackerAlive(42, '/run/api.sock', join(ctx.dir, 'proc'))).toBeFalse();
});

test('#waitForExit resolves true once the firecracker is gone', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  child.kill('SIGKILL');

  const exited = await waitForExit(child.pid, join(ctx.dir, 'api.sock'), 4000);

  expect(exited).toBeTrue();
});

test('#waitForExit resolves false at the timeout while the firecracker still runs', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));
  const exited = await waitForExit(child.pid, join(ctx.dir, 'api.sock'), 20);

  expect(exited).toBeFalse();
});

test('#stopProcess kills a running process', async () => {
  const child = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  stopProcess(child.pid);

  await child.exited;

  expect(child.signalCode).toBe('SIGKILL');
});

test('#stopProcess ignores a process that is gone', async () => {
  const child = Bun.spawn(['true']);

  await child.exited;

  expect(() => {
    stopProcess(child.pid);
  }).not.toThrow();
});

test('#readPidFile reads a missing pid file as none', () => {
  const ctx = setupTest();

  expect(readPidFile(join(ctx.dir, 'pid'))).toBeNull();
});

test.each([
  ['4242\n', 4242],
  ['half', null],
  ['0', null],
  ['-3', null],
])('#readPidFile reads a pid file of %j as %p', (content, expected) => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'pid'), content);

  expect(readPidFile(join(ctx.dir, 'pid'))).toBe(expected);
});

test('#readLogTail reads the last lines of the log', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'log'), 'one\ntwo\nthree\n');

  expect(readLogTail(join(ctx.dir, 'log'), 2)).toBe('two\nthree');
});

test('#readLogTail reads a missing log as none', () => {
  const ctx = setupTest();

  expect(readLogTail(join(ctx.dir, 'log'))).toBe('(no log)');
});

test('#buildSpawnArgv detaches the command', () => {
  expect(buildSpawnArgv(['firecracker', '--api-sock', 'api.sock'], null, null)).toStrictEqual([
    'setsid',
    'firecracker',
    '--api-sock',
    'api.sock',
  ]);
});

test('#buildSpawnArgv puts the merge wrapper before a plain firecracker', () => {
  expect(
    buildSpawnArgv(
      buildFirecrackerCommand('/usr/local/bin/firecracker', 'api.sock'),
      null,
      'ksm-exec',
    ),
  ).toStrictEqual(['setsid', 'ksm-exec', '/usr/local/bin/firecracker', '--api-sock', 'api.sock']);
});

test('#buildSpawnArgv puts the merge wrapper before the jailer, so the chroot needs no copy of it', () => {
  const jailer = buildJailerCommand({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase: '/var/lib/imp/jail',
    impId: 'imp',
    user: { uid: 900_000, gid: 900_000 },
    apiSocket: 'api.sock',
  });

  expect(buildSpawnArgv(jailer, null, 'ksm-exec')).toStrictEqual(['setsid', 'ksm-exec', ...jailer]);
});

// /usr/bin/env stands in for ksm-exec: it execs the rest of its argv
test('#buildSpawnArgv records the pid in the cgroup and execs the wrapper and the command', () => {
  const ctx = setupTest();
  const procs = join(ctx.dir, 'cgroup.procs');

  const result = Bun.spawnSync(
    buildSpawnArgv(['echo', '--api-sock', 'api.sock'], procs, '/usr/bin/env'),
  );

  expect(result.stdout.toString()).toBe('--api-sock api.sock\n');
  expect(readFileSync(procs, 'utf8').trim()).toBe(String(result.pid));
});

test('#buildFirecrackerCommand names the API socket', () => {
  expect(buildFirecrackerCommand('/usr/local/bin/firecracker', '/i1/api.sock')).toStrictEqual([
    '/usr/local/bin/firecracker',
    '--api-sock',
    '/i1/api.sock',
  ]);
});

test('#startFirecracker resolves with the pid and writes it to the pid file once the socket opens', async () => {
  const ctx = setupTest();
  const apiSocket = join(ctx.dir, 'api.sock');

  // stands in for Firecracker: it makes its API socket path, then runs on
  const pid = await startFirecracker(['sh', '-c', 'touch "$0"; exec sleep 30', apiSocket], {
    apiSocket,
    vsockSocket: join(ctx.dir, 'vsock.sock'),
    logFile: join(ctx.dir, 'log'),
    pidFile: join(ctx.dir, 'pid'),
  });

  onTestFinished(() => {
    stopProcess(pid);
  });

  expect(readPidFile(join(ctx.dir, 'pid'))).toBe(pid);
});

test('#startFirecracker rejects with the log tail when the process exits before its socket opens', () => {
  const ctx = setupTest();

  expect(
    startFirecracker(['sh', '-c', 'echo no kvm >&2; exit 1'], {
      apiSocket: join(ctx.dir, 'api.sock'),
      vsockSocket: join(ctx.dir, 'vsock.sock'),
      logFile: join(ctx.dir, 'log'),
      pidFile: join(ctx.dir, 'pid'),
    }),
  ).rejects.toThrowWithMessage(Error, 'firecracker did not open its API socket (exit 1): no kvm');
});

test('#readVmOwner reads the uid and the cgroup of a process', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(readVmOwner(child.pid)).toStrictEqual({
    uid: process.getuid?.() ?? 0,
    cgroup: readProcessCgroup(child.pid),
  });
});

test('#isImpVm takes a VM that runs as impd, unjailed', () => {
  expect(isImpVm({ uid: process.getuid?.() ?? 0, cgroup: '/other' }, 'i1', null)).toBeTrue();
});

test('#isImpVm takes a VM that runs as the imp jail uid', () => {
  expect(isImpVm({ uid: 900_001, cgroup: '/other' }, 'i1', 900_001)).toBeTrue();
});

test('#isImpVm takes a VM in the imp cgroup', () => {
  expect(isImpVm({ uid: 900_002, cgroup: '/imps/i1' }, 'i1', null)).toBeTrue();
});

test('#isImpVm refuses a VM of another uid in another cgroup', () => {
  expect(isImpVm({ uid: 900_002, cgroup: '/imps/i2' }, 'i1', 900_001)).toBeFalse();
});

test('#isJailedFirecracker finds a process run with --id', async () => {
  // `; true` keeps bash from execing sleep in place, so its argv keeps --id
  const child = Bun.spawn(['bash', '-c', 'sleep 30; true', 'x', '--id', 'i1']);

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  await waitFor(() => {
    expect(readFileSync(`/proc/${String(child.pid)}/cmdline`, 'utf8').split('\0')).toContain(
      '--id',
    );
  });

  expect(isJailedFirecracker(child.pid)).toBeTrue();
});

test('#isJailedFirecracker finds an unjailed firecracker not jailed', async () => {
  const ctx = setupTest();

  const child = await startStubFirecrackerProcess(join(ctx.dir, 'api.sock'));

  expect(isJailedFirecracker(child.pid)).toBeFalse();
});
