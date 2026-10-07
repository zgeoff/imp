import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../test-utils/start-cli';

test('it refuses a relative path for --on-host, which names no directory on the impd host', async () => {
  const result = await runCli({
    args: ['image', 'build', 'images/base', '--name', 'base', '--on-host'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --on-host takes an absolute path on the impd host, not images/base\n',
    code: 2,
  });
});

test('it refuses a build context without a Dockerfile before any upload', async () => {
  const context = await mkdtemp(join(tmpdir(), 'imp-empty-context-'));

  onTestFinished(() => rm(context, { recursive: true, force: true }));

  const result = await runCli({
    args: ['image', 'build', context, '--name', 'base'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  const received: unknown = result;

  expect(received).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/^imp: there is no Dockerfile in /u) as unknown,
    code: 2,
  });
});
