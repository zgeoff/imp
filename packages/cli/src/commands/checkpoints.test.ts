import { expect, test } from 'bun:test';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';

test('it prints the usage of checkpoint rm with too few arguments instead of creating a checkpoint', async () => {
  const result = await runCLIInProcess({
    args: ['checkpoint', 'rm', 'box'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: usage: impz checkpoint rm <name> <checkpoint>\n',
    code: 2,
  });
});
