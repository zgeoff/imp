import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canUpdateReadOnly } from '@impz/test-utils/can-update-read-only';
import { updateReadOnly } from '@impz/test-utils/update-read-only';
import { runCli } from './test-utils/start-cli';

// the CLI's HOME; `stack` makes a read-only HOME writable again before it goes
function setupTest() {
  const stack = new DisposableStack();

  onTestFinished(() => {
    stack.dispose();
  });

  const home = mkdtempSync(join(tmpdir(), 'impz-main-'));

  stack.defer(() => {
    rmSync(home, { recursive: true, force: true });
  });

  return { home, stack };
}

test.skipIf(!canUpdateReadOnly()).each([[['--version']], [['--help']], [['completion', 'bash']]])(
  'it runs %p beside a config from before the rename to impz under a read-only home',
  async (args) => {
    const ctx = setupTest();

    mkdirSync(join(ctx.home, '.config', 'imp'), { recursive: true });

    writeFileSync(
      join(ctx.home, '.config', 'imp', 'config.json'),
      '{"current":null,"hosts":{}}\n',
      {
        mode: 0o600,
      },
    );

    updateReadOnly(ctx.stack, ctx.home);

    const result = await runCli({ args, env: { HOME: ctx.home } });

    expect({ stderr: result.stderr, code: result.code }).toStrictEqual({ stderr: '', code: 0 });
  },
);

test('it moves a config from before the rename to impz on a command that reads it', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'imp'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'imp', 'config.json'),
    '{"current":"home","hosts":{"home":{"url":"https://home.example","token":"secret"}}}\n',
    { mode: 0o600 },
  );

  const result = await runCli({ args: ['hosts'], env: { HOME: ctx.home } });

  expect(result).toStrictEqual({
    stdout: [
      '   NAME  URL                   TOKEN',
      '*  home  https://home.example  saved',
      '',
    ].join('\n'),
    stderr: `impz: moved ${join(ctx.home, '.config', 'imp', 'config.json')} to ${join(ctx.home, '.config', 'impz', 'config.json')}\n`,
    code: 0,
  });

  expect(readdirSync(join(ctx.home, '.config'))).toStrictEqual(['impz']);

  expect(readFileSync(join(ctx.home, '.config', 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":"home","hosts":{"home":{"url":"https://home.example","token":"secret"}}}\n',
  );
});
