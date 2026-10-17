import { expect, test } from 'bun:test';
import { runCLIInProcess } from './test-utils/run-cli-in-process';

test('it hands every command the saved host --host names, the last one when given twice', async () => {
  const result = await runCLIInProcess({ args: ['--host', 'nowhere', 'ls', '--host=work'] });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: no saved host work (see impz host ls, or impz login <url> --name work)\n',
    code: 2,
  });
});

test('it refuses a --host that is no host name before the command runs', async () => {
  const result = await runCLIInProcess({ args: ['ls', '--host', 'https://imp.example'] });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      "impz: not a host name: https://imp.example (letters, digits, '.', '_' and '-'; a URL goes to impz login)\n",
    code: 2,
  });
});

test('it leaves a --host after -- to the command impz exec runs', async () => {
  const result = await runCLIInProcess({
    args: ['exec', 'box', '--', 'echo', '--host', 'nowhere'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result.stderr).toStartWith('impz: cannot reach impd at http://127.0.0.1:1');
});
