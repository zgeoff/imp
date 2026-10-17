import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test sources load-env-file.sh in bash under set -euo pipefail, as host/entrypoint does,
// and prints what the shell holds after it.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-load-env-file-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    script: new URL('load-env-file.sh', import.meta.url).pathname,
  };
}

test('it exports each line as docker --env-file reads it, with no expansion', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'env'),
    [
      '# a comment',
      '',
      'PLAIN=value',
      'QUOTED="kept quotes"',
      '   INDENTED=a b  ',
      'DOLLAR=$HOME and $(echo no)',
      'CRLF=windows\r',
      'EMPTY=',
      'BARE',
      'LAST=no newline',
    ].join('\n'),
  );

  // a child shell prints them, so each one is exported, not only set
  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'set -euo pipefail; . "$0" "$1"; exec bash -c "$2"',
      ctx.script,
      join(ctx.dir, 'env'),
      String.raw`printf "[%s]\n" "$PLAIN" "$QUOTED" "$INDENTED" "$DOLLAR" "$CRLF" "$LAST"; [ -v EMPTY ] && echo EMPTY set; [ -v BARE ] || echo BARE unset`,
    ],
    { env: { PATH: process.env['PATH'] ?? '' } },
  );

  expect(result.stderr.toString()).toBe('');

  expect(result.stdout.toString()).toBe(
    '[value]\n["kept quotes"]\n[a b  ]\n[$HOME and $(echo no)]\n[windows]\n[no newline]\nEMPTY set\nBARE unset\n',
  );
});

test('it sets a key over the value the environment holds', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'env'), 'IMP_DAEMON=/from/the/file\n');

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'set -euo pipefail; . "$0" "$1"; echo "$IMP_DAEMON"',
      ctx.script,
      join(ctx.dir, 'env'),
    ],
    { env: { PATH: process.env['PATH'] ?? '', IMP_DAEMON: '/from/the/image' } },
  );

  expect(result.stdout.toString()).toBe('/from/the/file\n');
});

test('it stops the shell on a line with no valid name, naming the line but not its value', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'env'), 'GOOD=1\nBAD KEY=fake-secret\n');

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'set -euo pipefail; . "$0" "$1"; echo went on',
      ctx.script,
      join(ctx.dir, 'env'),
    ],
    { env: { PATH: process.env['PATH'] ?? '' } },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe('');

  expect(result.stderr.toString()).toBe(
    `load-env-file: ${join(ctx.dir, 'env')} line 2 has no valid variable name\n`,
  );
});

test('it stops the shell when the file is missing', () => {
  const ctx = setupTest();

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'set -euo pipefail; . "$0" "$1"; echo went on',
      ctx.script,
      join(ctx.dir, 'none'),
    ],
    { env: { PATH: process.env['PATH'] ?? '' } },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe('');
});
