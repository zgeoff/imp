import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { runSuite, stopSuiteGroup } from './run-suite';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'run-suite-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#runSuite returns 0 for a suite that passes', async () => {
  const ctx = await setupTest();

  const exitCode = await runSuite({
    argv: [process.execPath, '-e', 'process.exit(0)'],
    cwd: ctx.dir,
    env: process.env,
    onStart: () => {},
  });

  expect(exitCode).toBe(0);
});

test('#runSuite returns the exit code of a suite that fails', async () => {
  const ctx = await setupTest();

  const exitCode = await runSuite({
    argv: [process.execPath, '-e', 'process.exit(3)'],
    cwd: ctx.dir,
    env: process.env,
    onStart: () => {},
  });

  expect(exitCode).toBe(3);
});

test('#stopSuiteGroup stops a running suite and the processes it started', async () => {
  const ctx = await setupTest();

  const marker = join(ctx.dir, 'started');
  const started = Promise.withResolvers<number>();

  // a suite that starts a child of its own, as the imp CLI calls do, and
  // writes the child's pid once it runs
  const running = runSuite({
    argv: [
      process.execPath,
      '-e',
      'const child = Bun.spawn(["sleep", "1000"]); await Bun.write(process.argv[1], String(child.pid)); setInterval(() => {}, 1000)',
      marker,
    ],
    cwd: ctx.dir,
    env: process.env,
    onStart: (pid) => {
      started.resolve(pid);
    },
  });

  const pid = await started.promise;

  const grandchild = await waitFor(
    async () => {
      const text = await readFile(marker, 'utf8');

      // a pid, not a file caught half written
      expect(text).toMatch(/^[1-9]\d*$/);

      return Number(text);
    },
    { timeoutMs: 10_000 },
  );

  stopSuiteGroup(pid, 'SIGTERM');

  const exitCode = await running;

  expect(exitCode).not.toBe(0);

  // gone: signal 0 to its pid finds no process
  await waitFor(
    () => {
      expect(() => process.kill(grandchild, 0)).toThrow(/ESRCH/);
    },
    { timeoutMs: 10_000 },
  );
});

test('#stopSuiteGroup treats a group that already exited as stopped', async () => {
  const ctx = await setupTest();

  const started = Promise.withResolvers<number>();

  await runSuite({
    argv: [process.execPath, '-e', 'process.exit(0)'],
    cwd: ctx.dir,
    env: process.env,
    onStart: (pid) => {
      started.resolve(pid);
    },
  });

  const pid = await started.promise;

  expect(() => {
    stopSuiteGroup(pid, 'SIGTERM');
  }).not.toThrow();
});
