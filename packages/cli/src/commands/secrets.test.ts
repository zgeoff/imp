import { expect, test } from 'bun:test';
import { runCli } from '../test-utils/start-cli';

test('it refuses a secret value given as a flag, which only stdin may carry', async () => {
  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--value', 'ghp_x'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: unknown flag --value for add (see --help)\n',
    code: 2,
  });
});

test.each([
  [
    'an unknown kind',
    ['--kind', 'gitlab'],
    'imp: --kind must be one of github, anthropic, npm, custom, oauth',
  ],
  ['a custom kind without hosts', ['--kind', 'custom'], 'imp: --kind custom needs --hosts'],
  [
    'hosts on a github kind',
    ['--kind', 'github', '--hosts', 'api.github.com'],
    'imp: --hosts, --header, --scheme and --user are for --kind custom and --kind oauth',
  ],
  ['an oauth kind without hosts', ['--kind', 'oauth'], 'imp: --kind oauth needs --hosts'],
  [
    'an oauth kind without a token URL and client ID',
    ['--kind', 'oauth', '--hosts', 'api.example.com'],
    'imp: --kind oauth needs --token-url and --client-id',
  ],
  [
    'an http token URL',
    [
      '--kind',
      'oauth',
      '--hosts',
      'api.example.com',
      '--token-url',
      'http://a.example.com/t',
      '--client-id',
      'c',
    ],
    'imp: Invalid URL',
  ],
  [
    'an unknown token format',
    [
      '--kind',
      'oauth',
      '--hosts',
      'api.example.com',
      '--token-url',
      'https://a.example.com/t',
      '--client-id',
      'c',
      '--token-format',
      'xml',
    ],
    'imp: Invalid option: expected one of "json"|"form"',
  ],
  [
    'oauth flags on a custom kind',
    ['--kind', 'custom', '--hosts', 'api.example.com', '--client-id', 'c'],
    'imp: --token-url, --client-id and --token-format are for --kind oauth',
  ],
  [
    'an address as a host',
    ['--kind', 'custom', '--hosts', '10.0.0.1'],
    'imp: must be a lowercase hostname such as api.example.com',
  ],
  [
    'an unknown scheme',
    ['--kind', 'custom', '--hosts', 'api.example.com', '--scheme', 'digest'],
    'imp: Invalid option: expected one of "bearer"|"basic"|"raw"',
  ],
])('it refuses %s before it asks for a value', async (_case, flags, message) => {
  const result = await runCli({
    args: ['secret', 'add', 'api', ...flags],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: `${message}\n`, code: 2 });
});

test('it refuses an audit limit outside 1 to 1000', async () => {
  const result = await runCli({
    args: ['audit', '--limit', '0'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --limit must be a whole number from 1 to 1000\n',
    code: 2,
  });
});
