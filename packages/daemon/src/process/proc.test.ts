import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPids, readStatFields, stopPid } from './proc';

function setupTest() {
  const procRoot = mkdtempSync(join(tmpdir(), 'proc-'));

  onTestFinished(() => {
    rmSync(procRoot, { recursive: true, force: true });
  });

  return { procRoot };
}

test('#readStatFields reads the fields after a command name that holds spaces and parentheses', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (fire (x) cracker) S 1 42 42 0\n');

  expect(readStatFields(42, ctx.procRoot)).toStrictEqual(['S', '1', '42', '42', '0']);
});

test('#readStatFields reads null for a process that is gone', () => {
  const ctx = setupTest();

  expect(readStatFields(42, ctx.procRoot)).toBeNull();
});

test('#readStatFields reads this process from the real /proc', () => {
  expect(readStatFields(process.pid)?.[0]).toBeOneOf(['R', 'S']);
});

test('#listPids lists only the numeric entries', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '7'));
  mkdirSync(join(ctx.procRoot, '12'));
  mkdirSync(join(ctx.procRoot, 'self'));
  writeFileSync(join(ctx.procRoot, 'meminfo'), '');

  expect(listPids(ctx.procRoot)).toIncludeSameMembers([7, 12]);
});

test('#stopPid passes over a process that is gone', () => {
  // past the kernel's largest pid_max, 2^22, so no process holds it
  expect(() => {
    stopPid(2 ** 31 - 1);
  }).not.toThrow();
});

test('#stopPid kills a running process', async () => {
  const child = Bun.spawn(['sleep', '30']);

  onTestFinished(() => {
    child.kill();
  });

  stopPid(child.pid);

  await child.exited;

  expect(child.signalCode).toBe('SIGKILL');
});
