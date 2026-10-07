import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSOLE_SHELL, buildConsoleShell } from './login-shell';

function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-login-shell-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    dir,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it runs the current user’s shell from the passwd file as a login shell', () => {
  using ctx = setupTest();

  const shell = join(ctx.dir, 'user-shell');

  writeFileSync(shell, '#!/bin/sh\necho "user-shell $*"\n', { mode: 0o755 });

  writeFileSync(
    join(ctx.dir, 'passwd'),
    `dev:x:${String(process.getuid?.())}:100::/home/dev:${shell}\n`,
  );

  const run = Bun.spawnSync(
    ['/bin/sh', '-c', buildConsoleShell(join(ctx.dir, 'passwd'), ['/nonexistent/sh'])],
    { timeout: 5000 },
  );

  expect({ stdout: run.stdout.toString(), exitCode: run.exitCode }).toStrictEqual({
    stdout: 'user-shell -l\n',
    exitCode: 0,
  });
});

test('it skips the passwd entries of other users', () => {
  using ctx = setupTest();

  const other = join(ctx.dir, 'other-shell');
  const shell = join(ctx.dir, 'user-shell');

  writeFileSync(other, '#!/bin/sh\necho "other-shell $*"\n', { mode: 0o755 });
  writeFileSync(shell, '#!/bin/sh\necho "user-shell $*"\n', { mode: 0o755 });

  writeFileSync(
    join(ctx.dir, 'passwd'),
    [
      `other:x:${String((process.getuid?.() ?? 0) + 1)}:100::/home/other:${other}`,
      `dev:x:${String(process.getuid?.())}:100::/home/dev:${shell}`,
      '',
    ].join('\n'),
  );

  const run = Bun.spawnSync(
    ['/bin/sh', '-c', buildConsoleShell(join(ctx.dir, 'passwd'), ['/nonexistent/sh'])],
    { timeout: 5000 },
  );

  expect(run.stdout.toString()).toBe('user-shell -l\n');
});

test('it falls back to the first executable fallback when the user’s shell is missing', () => {
  using ctx = setupTest();

  const fallback = join(ctx.dir, 'fallback-shell');

  writeFileSync(fallback, '#!/bin/sh\necho "fallback-shell $*"\n', { mode: 0o755 });

  writeFileSync(
    join(ctx.dir, 'passwd'),
    `dev:x:${String(process.getuid?.())}:100::/home/dev:${join(ctx.dir, 'missing-shell')}\n`,
  );

  const run = Bun.spawnSync(
    [
      '/bin/sh',
      '-c',
      buildConsoleShell(join(ctx.dir, 'passwd'), [join(ctx.dir, 'no-such-shell'), fallback]),
    ],
    { timeout: 5000 },
  );

  expect(run.stdout.toString()).toBe('fallback-shell -l\n');
});

test('it falls back when the passwd file has no entry for the user', () => {
  using ctx = setupTest();

  const fallback = join(ctx.dir, 'fallback-shell');

  writeFileSync(fallback, '#!/bin/sh\necho "fallback-shell $*"\n', { mode: 0o755 });
  writeFileSync(join(ctx.dir, 'passwd'), '');

  const run = Bun.spawnSync(
    ['/bin/sh', '-c', buildConsoleShell(join(ctx.dir, 'passwd'), [fallback])],
    { timeout: 5000 },
  );

  expect(run.stdout.toString()).toBe('fallback-shell -l\n');
});

test('it passes on the exit code of the login shell', () => {
  using ctx = setupTest();

  const shell = join(ctx.dir, 'user-shell');

  writeFileSync(shell, '#!/bin/sh\nexit 3\n', { mode: 0o755 });

  writeFileSync(
    join(ctx.dir, 'passwd'),
    `dev:x:${String(process.getuid?.())}:100::/home/dev:${shell}\n`,
  );

  const run = Bun.spawnSync(
    ['/bin/sh', '-c', buildConsoleShell(join(ctx.dir, 'passwd'), ['/nonexistent/sh'])],
    { timeout: 5000 },
  );

  expect(run.exitCode).toBe(3);
});

test('it reads the image’s /etc/passwd and falls back to bash, then sh, for consoles', () => {
  expect(CONSOLE_SHELL).toBe(buildConsoleShell('/etc/passwd', ['/bin/bash', '/bin/sh']));
});
