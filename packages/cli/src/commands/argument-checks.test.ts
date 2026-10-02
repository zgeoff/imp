import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { runCommand } from 'citty';
import { checkpointCommand } from './checkpoints';
import { imageCommand } from './image';
import { consoleCommand, newCommand, readConsoleSession } from './imps';
import { auditCommand, secretCommand } from './secrets';
import { sessionsCommand } from './sessions';

// These fail before any call to impd, so they need none: IMP_URL points
// nowhere, and a call that slipped through would fail with another message.

beforeEach(() => {
  process.env['IMP_URL'] = 'http://127.0.0.1:1';
  process.exitCode = 0;
});

afterEach(() => {
  mock.restore();
  delete process.env['IMP_URL'];
  process.exitCode = 0;
});

function setupStderr() {
  return spyOn(console, 'error').mockImplementation(() => {
    // captured
  });
}

test('checkpoint rm with too few arguments fails instead of creating a checkpoint', async () => {
  const stderr = setupStderr();

  await runCommand(checkpointCommand, { rawArgs: ['rm', 'box'] });

  expect(stderr).toHaveBeenCalledWith('imp: usage: imp checkpoint rm <name> <checkpoint>');
  expect(process.exitCode).toBe(2);
});

test('image build rejects a relative path, which names no directory on the impd host', async () => {
  const stderr = setupStderr();

  await runCommand(imageCommand, { rawArgs: ['build', 'images/base', '--name', 'base'] });

  expect(stderr).toHaveBeenCalledWith(
    'imp: the build context is a directory on the impd host: give its absolute path, not images/base',
  );

  expect(process.exitCode).toBe(2);
});

test('a size or count that is not a whole positive number is a usage error', async () => {
  const stderr = setupStderr();

  await runCommand(newCommand, { rawArgs: ['box', '--memory', '1.5g'] });

  expect(stderr).toHaveBeenCalledWith(
    'imp: not a size: 1.5g (try 512m, 2g, or MiB as a whole number)',
  );

  expect(process.exitCode).toBe(2);
});

test('an IMP_URL that is not an http URL is a usage error', async () => {
  const stderr = setupStderr();

  process.env['IMP_URL'] = 'localhost:7070';

  await runCommand(newCommand, { rawArgs: ['box'] });

  expect(stderr).toHaveBeenCalledWith('imp: IMP_URL is not an http(s) URL: localhost:7070');
  expect(process.exitCode).toBe(2);
});

test('sessions kill with too few arguments fails instead of listing', async () => {
  const stderr = setupStderr();

  await runCommand(sessionsCommand, { rawArgs: ['kill', 'box'] });

  expect(stderr).toHaveBeenCalledWith('imp: usage: imp sessions kill <name> <session>');
  expect(process.exitCode).toBe(2);
});

test('a detach key that is not ctrl-<key> is a usage error', async () => {
  const stderr = setupStderr();

  await runCommand(consoleCommand, { rawArgs: ['box', '--detach-key', 'esc'] });

  expect(stderr).toHaveBeenCalledWith(
    String.raw`imp: --detach-key takes ctrl-<key> (a-z but h, i, j and m; @, \, ], ^ or _) or none, got esc`,
  );

  expect(process.exitCode).toBe(2);
});

test('an empty session name is a usage error', async () => {
  const stderr = setupStderr();

  await runCommand(consoleCommand, { rawArgs: ['box', '--session', ''] });

  expect(stderr).toHaveBeenCalledWith('imp: a session needs a name');
  expect(process.exitCode).toBe(2);
});

test('console uses the session main by default only on a terminal', () => {
  expect(readConsoleSession(undefined, true)).toBe('main');
  expect(readConsoleSession(undefined, false)).toBeNull();
  expect(readConsoleSession('work', false)).toBe('work');
  expect(readConsoleSession(false, true)).toBeNull();
});

test('secret add takes its value from stdin only, never a flag', async () => {
  const stderr = setupStderr();

  await runCommand(secretCommand, {
    rawArgs: ['add', 'gh', '--kind', 'github', '--value', 'ghp_x'],
  });

  expect(stderr).toHaveBeenCalledWith('imp: unknown flag --value for add (see --help)');
  expect(process.exitCode).toBe(2);
});

test('secret add checks the kind and the custom rules before it asks for a value', async () => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [['--kind', 'gitlab'], 'imp: --kind must be one of github, anthropic, npm, custom'],
    [['--kind', 'custom'], 'imp: --kind custom needs --hosts'],
    [
      ['--kind', 'github', '--hosts', 'api.github.com'],
      'imp: --hosts, --header, --scheme and --user are for --kind custom',
    ],
    [
      ['--kind', 'custom', '--hosts', '10.0.0.1'],
      'imp: must be a lowercase hostname such as api.example.com',
    ],
    [
      ['--kind', 'custom', '--hosts', 'api.example.com', '--scheme', 'digest'],
      'imp: Invalid option: expected one of "bearer"|"basic"|"raw"',
    ],
  ];

  for (const [flags, message] of cases) {
    const stderr = setupStderr();

    await runCommand(secretCommand, { rawArgs: ['add', 'api', ...flags] });

    expect(stderr).toHaveBeenCalledWith(message);
    expect(process.exitCode).toBe(2);

    mock.restore();

    process.exitCode = 0;
  }
});

test('audit refuses a limit outside 1 to 1000', async () => {
  const stderr = setupStderr();

  await runCommand(auditCommand, { rawArgs: ['--limit', '0'] });

  expect(stderr).toHaveBeenCalledWith('imp: --limit must be a whole number from 1 to 1000');
  expect(process.exitCode).toBe(2);
});
