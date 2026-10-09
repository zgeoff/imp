import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isProcessOfUid,
  readProcessCgroup,
  readProcessUid,
  stopProcessOfUid,
} from './process-owner';

function setupTest() {
  const procRoot = mkdtempSync(join(tmpdir(), 'imp-proc-'));

  onTestFinished(() => {
    rmSync(procRoot, { recursive: true, force: true });
  });

  return { procRoot };
}

test('#readProcessUid reads the uid of a process whose real and effective uids agree', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '1'));

  writeFileSync(
    join(ctx.procRoot, '1', 'status'),
    'Name:\tfirecracker\nUid:\t900001\t900001\t900001\t900001\n',
  );

  expect(readProcessUid(1, ctx.procRoot)).toBe(900_001);
});

test('#readProcessUid reads no uid for a process whose real and effective uids differ', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '2'));
  writeFileSync(join(ctx.procRoot, '2', 'status'), 'Name:\tfirecracker\nUid:\t900001\t0\t0\t0\n');

  expect(readProcessUid(2, ctx.procRoot)).toBeNull();
});

test('#readProcessUid reads no uid for a process that is gone', () => {
  const ctx = setupTest();

  expect(readProcessUid(4, ctx.procRoot)).toBeNull();
});

test('#readProcessCgroup reads the cgroup v2 path of a process', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '3'));
  writeFileSync(join(ctx.procRoot, '3', 'cgroup'), '0::/imps/i1\n');

  expect(readProcessCgroup(3, ctx.procRoot)).toBe('/imps/i1');
});

test('#readProcessCgroup reads no cgroup for a process that is gone', () => {
  const ctx = setupTest();

  expect(readProcessCgroup(4, ctx.procRoot)).toBeNull();
});

test('#isProcessOfUid finds a process that runs as the uid', () => {
  expect(isProcessOfUid(process.pid, process.getuid?.() ?? 0)).toBeTrue();
});

test('#isProcessOfUid refuses a process that runs as another uid', () => {
  expect(isProcessOfUid(process.pid, 900_001)).toBeFalse();
});

test('#isProcessOfUid refuses a process that is gone', async () => {
  const child = Bun.spawn(['true']);

  await child.exited;

  expect(isProcessOfUid(child.pid, process.getuid?.() ?? 0)).toBeFalse();
});

test('#stopProcessOfUid kills a process that runs as the uid', async () => {
  const child = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  stopProcessOfUid(child.pid, process.getuid?.() ?? 0);

  await child.exited;

  expect(child.signalCode).toBe('SIGKILL');
});

test('#stopProcessOfUid sends nothing to a process of another uid', async () => {
  const child = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  stopProcessOfUid(child.pid, 900_001);

  // a SIGKILL sent above is pending before this one, and would end it first
  child.kill('SIGTERM');

  await child.exited;

  expect(child.signalCode).toBe('SIGTERM');
});

test('#stopProcessOfUid ignores a process that is gone and reaped', async () => {
  const child = Bun.spawn(['true']);

  await child.exited;

  expect(() => {
    stopProcessOfUid(child.pid, process.getuid?.() ?? 0);
  }).not.toThrow();
});
