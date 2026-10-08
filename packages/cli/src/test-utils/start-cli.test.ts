import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { runCli, startCli } from './start-cli';

test('#runCli returns the output and exit code of a usage error', async () => {
  const result = await runCli({
    args: ['gc', '--secret-files'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --secret-files goes with --orphans\n',
    code: 2,
  });
});

test('#runCli pipes stdin into the CLI', async () => {
  const home = await mkdtemp(join(tmpdir(), 'start-cli-'));

  onTestFinished(() => rm(home, { recursive: true, force: true }));

  const result = await runCli({
    args: ['login', 'http://127.0.0.1:1', '--name', 'home'],
    env: { HOME: home, XDG_CONFIG_HOME: home },
    stdin: 'a-token\n',
  });

  const received: unknown = result;

  expect(received).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(
      /^imp: cannot check the token with http:\/\/127\.0\.0\.1:1: /u,
    ) as unknown,
    code: 1,
  });
});

test('#runCli closes an empty stdin', async () => {
  const home = await mkdtemp(join(tmpdir(), 'start-cli-'));

  onTestFinished(() => rm(home, { recursive: true, force: true }));

  const result = await runCli({
    args: ['login', 'http://127.0.0.1:1', '--name', 'home'],
    env: { HOME: home, XDG_CONFIG_HOME: home },
    stdin: '',
  });

  expect(result.stderr).toBe('imp: no token given; nothing saved\n');
});

test('#runCli keeps the test run’s variables from the CLI', async () => {
  updateEnv('IMP_URL', 'localhost:7070');

  const result = await runCli({ args: ['gc', '--secret-files'] });

  expect(result.stderr).toBe('imp: --secret-files goes with --orphans\n');
});

test('#startCli hands the running process to the caller', async () => {
  const child = startCli({ args: ['--version'] });

  onTestFinished(() => {
    child.kill();
  });

  const code = await child.exited;

  expect(code).toBe(0);
});
