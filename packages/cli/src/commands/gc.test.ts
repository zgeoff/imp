import { expect, test } from 'bun:test';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';

test('it refuses --secret-files without --orphans before it deletes anything', async () => {
  const result = await runCLIInProcess({
    args: ['gc', '--secret-files'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --secret-files goes with --orphans\n',
    code: 2,
  });
});
