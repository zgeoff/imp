import { expect, test } from 'bun:test';
import { runCli } from '../test-utils/start-cli';
import { listForkWarnings, readConsoleSession } from './imps';

test('#listForkWarnings names each grant the fork did not get', () => {
  const fork = {
    name: 'dev-b',
    grantsNotCopied: [
      { secret: 'gh', reason: 'not-grantable' as const },
      { secret: 'npm', reason: 'clash' as const },
    ],
  };

  expect(listForkWarnings('dev-a', fork)).toStrictEqual([
    'dev-b: grant gh of dev-a not copied: not-grantable',
    'dev-b: grant npm of dev-a not copied: clash',
  ]);
});

test('#listForkWarnings names a copy of the grants that failed as a whole', () => {
  const fork = { name: 'dev-b', grantsNotCopied: [], grantsError: 'the copy failed' };

  expect(listForkWarnings('dev-a', fork)).toStrictEqual(['dev-b: the copy failed']);
});

test('#listForkWarnings warns of nothing for a fork from an impd that predates the report', () => {
  expect(listForkWarnings('dev-a', { name: 'dev-b' })).toBeEmpty();
});

test('#new refuses a size that is not a whole positive number', async () => {
  const result = await runCli({
    args: ['new', 'box', '--memory', '1.5g'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: not a size: 1.5g (try 512m, 2g, 1t, or MiB as a whole number)\n',
    code: 2,
  });
});

test('#new refuses an IMP_URL that is not an http URL', async () => {
  const result = await runCli({ args: ['new', 'box'], env: { IMP_URL: 'localhost:7070' } });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: IMP_URL is not an http(s) URL: localhost:7070\n',
    code: 2,
  });
});

test('#console refuses a detach key that is not ctrl-<key>', async () => {
  const result = await runCli({
    args: ['console', 'box', '--detach-key', 'esc'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: String.raw`imp: --detach-key takes ctrl-<key> (a-z but h, i, j and m; @, \, ], ^ or _) or none, got esc
`,
    code: 2,
  });
});

test('#console refuses an empty session name', async () => {
  const result = await runCli({
    args: ['console', 'box', '--session', ''],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'imp: a session needs a name\n', code: 2 });
});

test.each([
  ['no session on a terminal', undefined, true, 'main'],
  ['no session off a terminal', undefined, false, null],
  ['a named session off a terminal', 'work', false, 'work'],
  ['--no-session on a terminal', false, true, null],
] as const)(
  '#readConsoleSession picks the console session for %s',
  (_case, session, isTerminal, expected) => {
    expect(readConsoleSession(session, isTerminal)).toBe(expected);
  },
);
