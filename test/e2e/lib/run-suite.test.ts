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

test('#stopSuiteGroup stops a running suite through its group', async () => {
  const ctx = await setupTest();

  const marker = join(ctx.dir, 'started');
  const started = Promise.withResolvers<number>();

  const running = runSuite({
    argv: [
      process.execPath,
      '-e',
      'await Bun.write(process.argv[1], "imp"); setInterval(() => {}, 1000)',
      marker,
    ],
    cwd: ctx.dir,
    env: process.env,
    onStart: (pid) => {
      started.resolve(pid);
    },
  });

  const pid = await started.promise;

  await waitFor(() => readFile(marker), { timeoutMs: 10_000 });

  stopSuiteGroup(pid, 'SIGINT');

  const exitCode = await running;

  expect(exitCode).not.toBe(0);
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
