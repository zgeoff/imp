import { expect, test } from 'bun:test';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';

test('it prints the usage of sessions kill with too few arguments instead of listing', async () => {
  const result = await runCLIInProcess({
    args: ['sessions', 'kill', 'box'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: usage: impz sessions kill <name> <session>\n',
    code: 2,
  });
});
