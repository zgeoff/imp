import { expect, test } from 'bun:test';
import { runCLIInProcess } from './test-utils/run-cli-in-process';

test('#defineGroup prints its usage and fails as a usage error when run without a command', async () => {
  const result = await runCLIInProcess({ args: ['host'] });

  expect(result).toStrictEqual({
    stdout: [
      'Manage saved impd hosts (see also impz login) (impz host v2.4.1)',
      '',
      'USAGE impz host ls|use|rm',
      '',
      'COMMANDS',
      '',
      '   ls    List saved hosts; * marks the current one',
      '  use    Make a saved host the current one        ',
      '   rm    Forget a saved host and its token        ',
      '',
      'Use impz host <command> --help for more information about a command.',
      '',
      '',
    ].join('\n'),
    stderr: 'impz: no command specified\n',
    code: 2,
  });
});
