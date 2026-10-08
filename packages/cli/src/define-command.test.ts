import { expect, mock, test } from 'bun:test';
import { runCommand } from 'citty';
import { defineCommand } from './define-command';
import { runCli } from './test-utils/start-cli';

test.each([
  [['fork', 'a', 'b', '--from', 'cp1'], 'cp1'],
  [['fork', 'a', 'b', '--http-port', '80', '--httpPort=80', '-t', '--no-tty'], undefined],
  [['fork', 'a', 'b', '--', '--anything', '-x'], undefined],
])('it runs the command when given %p', async (rawArgs, from) => {
  const ran = mock<(from: unknown) => void>();

  const main = defineCommand({
    meta: { name: 'imp' },
    subCommands: {
      fork: defineCommand({
        meta: { name: 'fork' },
        args: {
          source: { type: 'positional', required: true },
          target: { type: 'positional', required: true },
          from: { type: 'string' },
          'http-port': { type: 'string' },
          tty: { type: 'boolean', alias: 't' },
        },
        run: (context) => {
          ran(context.args.from);
        },
      }),
    },
  });

  await runCommand(main, { rawArgs: [...rawArgs] });

  expect(ran).toHaveBeenCalledExactlyOnceWith(from);
});

test('it hands the command the host that --host names, last as main puts it', async () => {
  const ran = mock<(host: string | null) => void>();

  const main = defineCommand({
    meta: { name: 'imp' },
    subCommands: {
      ls: defineCommand({
        meta: { name: 'ls' },
        run: (context) => {
          ran(context.host);
        },
      }),
    },
  });

  await runCommand(main, { rawArgs: ['ls', '--host=work'] });

  expect(ran).toHaveBeenCalledExactlyOnceWith('work');
});

test('it refuses flags the command does not declare, with exit code 2 and no call', async () => {
  const result = await runCli({
    args: ['fork', 'a', 'b', '--checkpoint', 'cp1', '-v'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: unknown flags --checkpoint, -v for fork (see --help)\n',
    code: 2,
  });
});

test('it names a single undeclared flag as a flag', async () => {
  const result = await runCli({
    args: ['fork', 'a', 'b', '--zzz'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result.stderr).toBe('imp: unknown flag --zzz for fork (see --help)\n');
});
