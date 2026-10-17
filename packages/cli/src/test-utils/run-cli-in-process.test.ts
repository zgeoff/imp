import { expect, test } from 'bun:test';
import { updateEnv } from '@impz/test-utils/update-env';
import { runCLIInProcess } from './run-cli-in-process';

test('#runCLIInProcess returns the output and exit code of a usage error', async () => {
  const result = await runCLIInProcess({ args: ['rm'] });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: missing NAME (see --help)\n',
    code: 2,
  });
});

test('#runCLIInProcess pipes stdin into the command', async () => {
  const result = await runCLIInProcess({
    args: ['login', 'http://127.0.0.1:1', '--no-verify', '--name', 'work'],
    stdin: 'the-token\n',
  });

  expect(result).toStrictEqual({
    stdout: 'logged in to http://127.0.0.1:1 as work, now the current host\n',
    stderr: '',
    code: 0,
  });
});

test('#runCLIInProcess gives the command an empty stdin when the test pipes none', async () => {
  const result = await runCLIInProcess({ args: ['login', 'http://127.0.0.1:1', '--no-verify'] });

  expect(result.stderr).toBe('impz: no token given; nothing saved\n');
});

test('#runCLIInProcess keeps the test run’s variables from the command', async () => {
  updateEnv('IMP_URL', 'not a url');

  const result = await runCLIInProcess({ args: ['ls'] });

  expect(result.stderr).not.toInclude('IMP_URL');
});

test('#runCLIInProcess gives each run a HOME of its own', async () => {
  const saved = await runCLIInProcess({
    args: ['login', 'http://127.0.0.1:1', '--no-verify', '--name', 'work'],
    stdin: 'the-token\n',
  });

  const listed = await runCLIInProcess({ args: ['hosts', '--json'] });

  expect({ saved: saved.code, listed: listed.stdout }).toStrictEqual({ saved: 0, listed: '[]\n' });
});
