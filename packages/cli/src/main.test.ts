import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canUpdateReadOnly } from '@impz/test-utils/can-update-read-only';
import { updateReadOnly } from '@impz/test-utils/update-read-only';
import { runCLIInProcess } from './test-utils/run-cli-in-process';

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

    const result = await runCLIInProcess({ args, env: { HOME: ctx.home } });

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

  const result = await runCLIInProcess({ args: ['hosts'], env: { HOME: ctx.home } });

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

test('it refuses flags the command does not declare as a usage error, with no call', async () => {
  const result = await runCLIInProcess({
    args: ['fork', 'a', 'b', '--checkpoint', 'cp1', '-v'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: unknown flags --checkpoint, -v for fork (see --help)\n',
    code: 2,
  });
});

test('it names a single undeclared flag as a flag', async () => {
  const result = await runCLIInProcess({
    args: ['fork', 'a', 'b', '--zzz'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result.stderr).toBe('impz: unknown flag --zzz for fork (see --help)\n');
});

test('it refuses a command line with no imp name as a usage error', async () => {
  const result = await runCLIInProcess({ args: ['rm'], env: { IMP_URL: 'http://127.0.0.1:1' } });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: missing NAME (see --help)\n',
    code: 2,
  });
});

test('it refuses a command it does not have as a usage error', async () => {
  const result = await runCLIInProcess({ args: ['launch'] });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: unknown command launch (see impz --help)\n',
    code: 2,
  });
});

test('it exits 1 with one line when the call fails', async () => {
  const result: unknown = await runCLIInProcess({
    args: ['ls'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/^impz: [^\n]+\n$/u) as unknown,
    code: 1,
  });
});

test('it prints its version alone', async () => {
  const result: unknown = await runCLIInProcess({ args: ['--version'] });

  expect(result).toStrictEqual({
    stdout: expect.stringMatching(/^\d+\.\d+\.\d+\n$/u) as unknown,
    stderr: '',
    code: 0,
  });
});
