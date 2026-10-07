import { expect, test } from 'bun:test';
import { userInfo } from 'node:os';
import { CONSOLE_SHELL } from './login-shell';

// a login profile may print lines of its own, so the shell marks its answer
test('it runs the login shell from /etc/passwd for the current user', () => {
  const run = Bun.spawnSync(['/bin/sh', '-c', CONSOLE_SHELL], {
    stdin: new TextEncoder().encode('echo "imp-shell=$0"\nexit 3\n'),
  });

  const marked = run.stdout
    .toString()
    .split('\n')
    .filter((line) => line.startsWith('imp-shell='));

  expect({ marked, exitCode: run.exitCode }).toStrictEqual({
    marked: [`imp-shell=${userInfo().shell}`],
    exitCode: 3,
  });
});
