import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { runSuite } from './run-suite';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'run-suite-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir, marker: join(dir, 'left-behind') };
}

test('it resets the baseline after a suite that passes', async () => {
  const ctx = await setupTest();

  const outcome = await runSuite({
    argv: [process.execPath, '-e', 'await Bun.write(process.argv[1], "imp")', ctx.marker],
    cwd: ctx.dir,
    env: process.env,
    onStart: () => {},
    reset: () => rm(ctx.marker),
  });

  expect(outcome).toStrictEqual({ exitCode: 0, resetError: null });
  expect(existsSync(ctx.marker)).toBeFalse();
});

test('it resets the baseline after a suite that fails', async () => {
  const ctx = await setupTest();

  const outcome = await runSuite({
    argv: [
      process.execPath,
      '-e',
      'await Bun.write(process.argv[1], "imp"); process.exit(1)',
      ctx.marker,
    ],
    cwd: ctx.dir,
    env: process.env,
    onStart: () => {},
    reset: () => rm(ctx.marker),
  });

  expect(outcome).toStrictEqual({ exitCode: 1, resetError: null });
  expect(existsSync(ctx.marker)).toBeFalse();
});

test('it resets the baseline after a suite stopped by a signal to its group', async () => {
  const ctx = await setupTest();

  const started = Promise.withResolvers<number>();

  const running = runSuite({
    argv: [
      process.execPath,
      '-e',
      'await Bun.write(process.argv[1], "imp"); setInterval(() => {}, 1000)',
      ctx.marker,
    ],
    cwd: ctx.dir,
    env: process.env,
    onStart: (pid) => {
      started.resolve(pid);
    },
    reset: () => rm(ctx.marker),
  });

  const pid = await started.promise;

  await waitFor(() => readFile(ctx.marker), { timeoutMs: 10_000 });

  process.kill(-pid, 'SIGINT');

  const outcome = await running;

  expect(outcome.exitCode).not.toBe(0);
  expect(outcome.resetError).toBeNull();
  expect(existsSync(ctx.marker)).toBeFalse();
});

test('it leaves what a suite made when the run keeps it', async () => {
  const ctx = await setupTest();

  const outcome = await runSuite({
    argv: [process.execPath, '-e', 'await Bun.write(process.argv[1], "imp")', ctx.marker],
    cwd: ctx.dir,
    env: process.env,
    onStart: () => {},
    reset: null,
  });

  expect(outcome).toStrictEqual({ exitCode: 0, resetError: null });
  expect(existsSync(ctx.marker)).toBeTrue();
});

test('it reports a reset that fails', async () => {
  const ctx = await setupTest();

  const outcome = await runSuite({
    argv: [process.execPath, '-e', 'process.exit(0)'],
    cwd: ctx.dir,
    env: process.env,
    onStart: () => {},
    reset: () => rm(join(ctx.dir, 'missing')),
  });

  expect(outcome.resetError).toStartWith('ENOENT');
});

test('it hands the reset the code the suite exited with', async () => {
  const ctx = await setupTest();

  const reset = mock(() => Promise.resolve());

  await runSuite({
    argv: [process.execPath, '-e', 'process.exit(3)'],
    cwd: ctx.dir,
    env: process.env,
    onStart: () => {},
    reset,
  });

  expect(reset).toHaveBeenCalledExactlyOnceWith(3);
});
