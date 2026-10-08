import { expect, test } from 'bun:test';
import { runCli } from '../test-utils/start-cli';

test('it prints the usage of sessions kill with too few arguments instead of listing', async () => {
  const result = await runCli({
    args: ['sessions', 'kill', 'box'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: usage: imp sessions kill <name> <session>\n',
    code: 2,
  });
});
