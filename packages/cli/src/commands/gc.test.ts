import { expect, test } from 'bun:test';
import { runCli } from '../test-utils/start-cli';

test('it refuses --secret-files without --orphans before it deletes anything', async () => {
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
