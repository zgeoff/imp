import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A temp repo root with an empty src/ and an empty dashboard package src/.
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-branch-tests-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'packages/dashboard/src'), { recursive: true });

  return { dir };
}

test('it runs a dashboard test from the dashboard package and every other test from the root', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dir, 'package.json'), '{"scripts":{"test":"echo root"}}');

  await writeFile(
    join(ctx.dir, 'packages/dashboard/package.json'),
    '{"scripts":{"test":"echo dashboard"}}',
  );

  await writeFile(join(ctx.dir, 'src/a.ts'), '');
  await writeFile(join(ctx.dir, 'src/a.test.ts'), '');
  await writeFile(join(ctx.dir, 'packages/dashboard/src/view.tsx'), '');
  await writeFile(join(ctx.dir, 'packages/dashboard/src/view.test.tsx'), '');

  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-branch-tests.ts'),
      'src/a.ts',
      'packages/dashboard/src/view.tsx',
    ],
    { cwd: ctx.dir, stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect({ stdout, exitCode }).toStrictEqual({
    stdout: 'root ./src/a.test.ts\ndashboard ./src/view.test.tsx\n',
    exitCode: 0,
  });
});

test('it fails and still runs the dashboard tests when the root tests fail', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dir, 'package.json'), '{"scripts":{"test":"exit 1"}}');

  await writeFile(
    join(ctx.dir, 'packages/dashboard/package.json'),
    '{"scripts":{"test":"echo dashboard"}}',
  );

  await writeFile(join(ctx.dir, 'src/a.test.ts'), '');
  await writeFile(join(ctx.dir, 'packages/dashboard/src/view.test.tsx'), '');

  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-branch-tests.ts'),
      'src/a.test.ts',
      'packages/dashboard/src/view.test.tsx',
    ],
    { cwd: ctx.dir, stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect({ stdout, exitCode }).toStrictEqual({
    stdout: 'dashboard ./src/view.test.tsx\n',
    exitCode: 1,
  });
});

test('it fails when only the dashboard tests fail', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dir, 'package.json'), '{"scripts":{"test":"echo root"}}');

  await writeFile(
    join(ctx.dir, 'packages/dashboard/package.json'),
    '{"scripts":{"test":"exit 1"}}',
  );

  await writeFile(join(ctx.dir, 'packages/dashboard/src/view.test.tsx'), '');

  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-branch-tests.ts'),
      'packages/dashboard/src/view.test.tsx',
    ],
    { cwd: ctx.dir, stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect({ stdout, exitCode }).toStrictEqual({
    stdout: 'run-related-tests: no related tests\n',
    exitCode: 1,
  });
});
