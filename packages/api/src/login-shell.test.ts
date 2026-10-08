import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSOLE_SHELL, buildConsoleShell } from './login-shell';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-login-shell-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

test('#buildConsoleShell runs the current user’s shell from the passwd file as a login shell', () => {
  const ctx = setupTest();
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

test('#buildConsoleShell skips the passwd entries of other users', () => {
  const ctx = setupTest();
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

test('#buildConsoleShell falls back to the first executable fallback when the user’s shell is missing', () => {
  const ctx = setupTest();
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

test('#buildConsoleShell falls back when the passwd file has no entry for the user', () => {
  const ctx = setupTest();
  const fallback = join(ctx.dir, 'fallback-shell');

  writeFileSync(fallback, '#!/bin/sh\necho "fallback-shell $*"\n', { mode: 0o755 });
  writeFileSync(join(ctx.dir, 'passwd'), '');

  const run = Bun.spawnSync(
    ['/bin/sh', '-c', buildConsoleShell(join(ctx.dir, 'passwd'), [fallback])],
    { timeout: 5000 },
  );

  expect(run.stdout.toString()).toBe('fallback-shell -l\n');
});

test('#buildConsoleShell passes on the exit code of the login shell', () => {
  const ctx = setupTest();
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

test('#CONSOLE_SHELL reads /etc/passwd and falls back to bash, then sh', () => {
  expect(CONSOLE_SHELL).toBe(
    [
      'uid=$(id -u 2>/dev/null) || uid=0',
      'shell=',
      'while IFS=: read -r _ _ id _ _ _ login; do',
      '  if [ "$id" = "$uid" ]; then shell=$login; break; fi',
      'done < /etc/passwd',
      '[ -x "$shell" ] || shell=/bin/bash',
      '[ -x "$shell" ] || shell=/bin/sh',
      'exec "$shell" -l',
    ].join('\n'),
  );
});
