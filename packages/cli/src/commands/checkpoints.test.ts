import { expect, test } from 'bun:test';
import { runCli } from '../test-utils/start-cli';

test('it prints the usage of checkpoint rm with too few arguments instead of creating a checkpoint', async () => {
  const result = await runCli({
    args: ['checkpoint', 'rm', 'box'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: usage: imp checkpoint rm <name> <checkpoint>\n',
    code: 2,
  });
});
