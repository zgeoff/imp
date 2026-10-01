import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { runCommand } from 'citty';
import { defineCommand } from './define-command';

const ran: unknown[] = [];

const forkCommand = defineCommand({
  meta: { name: 'fork' },
  args: {
    source: { type: 'positional', required: true },
    target: { type: 'positional', required: true },
    from: { type: 'string' },
    'http-port': { type: 'string' },
    tty: { type: 'boolean', alias: 't' },
  },
  run: (context) => {
    ran.push(context.args.from);
  },
});

const main = defineCommand({ meta: { name: 'imp' }, subCommands: { fork: forkCommand } });

// bun keeps a non-zero exitCode set by a test unless it is reset to 0
beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  ran.length = 0;
  process.exitCode = 0;
});

test('it runs with declared flags in any spelling citty accepts', async () => {
  for (const rawArgs of [
    ['fork', 'a', 'b', '--from', 'cp1'],
    ['fork', 'a', 'b', '--http-port', '80', '--httpPort=80', '-t', '--no-tty'],
    ['fork', 'a', 'b', '--', '--anything', '-x'],
  ]) {
    await runCommand(main, { rawArgs });
  }

  expect(ran).toEqual(['cp1', undefined, undefined]);
  expect(process.exitCode).toBe(0);
});

test('it rejects a flag the command does not declare and does not run', async () => {
  const stderr = spyOn(console, 'error').mockImplementation(() => {
    // captured
  });

  await runCommand(main, { rawArgs: ['fork', 'a', 'b', '--checkpoint', 'cp1', '-v'] });

  expect(ran).toEqual([]);
  expect(process.exitCode).toBe(2);
  expect(stderr).toHaveBeenCalledWith('imp: unknown flags --checkpoint, -v for fork (see --help)');

  stderr.mockRestore();
});
