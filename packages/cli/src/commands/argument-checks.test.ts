import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from 'citty';
import { checkpointCommand } from './checkpoints';
import { gcCommand } from './gc';
import { imageCommand } from './image';
import { consoleCommand, newCommand, readConsoleSession } from './imps';
import { oauthCommand } from './oauth';
import { auditCommand, secretCommand } from './secrets';
import { sessionsCommand } from './sessions';
import { tokenCommand } from './tokens';

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

test('image build --on-host rejects a relative path, which names no directory on the impd host', async () => {
  const stderr = setupStderr();

  await runCommand(imageCommand, {
    rawArgs: ['build', 'images/base', '--name', 'base', '--on-host'],
  });

  expect(stderr).toHaveBeenCalledWith(
    'imp: --on-host takes an absolute path on the impd host, not images/base',
  );

  expect(process.exitCode).toBe(2);
});

test('image build without a Dockerfile in the context fails before any upload', async () => {
  const stderr = setupStderr();
  const empty = mkdtempSync(join(tmpdir(), 'imp-empty-context-'));

  try {
    await runCommand(imageCommand, { rawArgs: ['build', empty, '--name', 'base'] });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^imp: there is no Dockerfile in /u));
  expect(process.exitCode).toBe(2);
});

test('a size or count that is not a whole positive number is a usage error', async () => {
  const stderr = setupStderr();

  await runCommand(newCommand, { rawArgs: ['box', '--memory', '1.5g'] });

  expect(stderr).toHaveBeenCalledWith(
    'imp: not a size: 1.5g (try 512m, 2g, 1t, or MiB as a whole number)',
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

test('token new needs a known scope and well-formed imp patterns', async () => {
  const stderr = setupStderr();

  await runCommand(tokenCommand, { rawArgs: ['new', 'ci', '--scope', 'root'] });

  expect(stderr).toHaveBeenCalledWith('imp: --scope must be one of read, exec, manage');
  expect(process.exitCode).toBe(2);

  process.exitCode = 0;

  await runCommand(tokenCommand, { rawArgs: ['new', 'ci', '--scope', 'exec', '--imps', 'Dev*'] });

  expect(stderr).toHaveBeenCalledWith(
    'imp: --imps takes imp names with * for any run of characters, such as dev-*; not Dev*',
  );

  expect(process.exitCode).toBe(2);
});

test('token key add refuses a private key, an empty file and a missing one', async () => {
  const stderr = setupStderr();
  const dir = mkdtempSync(join(tmpdir(), 'imp-cli-key-'));
  const privateKey = join(dir, 'id_ed25519');
  const empty = join(dir, 'empty.pub');

  writeFileSync(privateKey, '-----BEGIN OPENSSH PRIVATE KEY-----\n');
  writeFileSync(empty, '# nothing\n');

  try {
    await runCommand(tokenCommand, { rawArgs: ['key', 'add', 'ci', privateKey] });

    expect(stderr).toHaveBeenCalledWith(`imp: ${privateKey} is a private key; give its .pub file`);

    await runCommand(tokenCommand, { rawArgs: ['key', 'add', 'ci', empty] });

    expect(stderr).toHaveBeenCalledWith(`imp: ${empty} holds no key`);

    await runCommand(tokenCommand, {
      rawArgs: ['new', 'ci', '--scope', 'exec', '--ssh-key', join(dir, 'missing.pub')],
    });

    expect(process.exitCode).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oauth commands refuse a redirect URI, a code or a pattern impd would refuse', async () => {
  const stderr = setupStderr();

  const cases: readonly (readonly [readonly string[], string])[] = [
    [
      ['client', 'add', 'conn', '--redirect-uri', 'http://client.example/cb'],
      'imp: --redirect-uri takes https URLs, or http on a loopback host, with no fragment; not http://client.example/cb',
    ],
    [
      ['client', 'set', 'conn', '--redirect-uri', 'https://client.example/cb#x'],
      'imp: --redirect-uri takes https URLs, or http on a loopback host, with no fragment; not https://client.example/cb#x',
    ],
    [['approve', 'ABCD-EFG0'], 'imp: ABCD-EFG0 is not a sign-in code; it looks like ABCD-EFGH'],
    [
      ['approve', 'ABCD-EFGH', '--scope', 'admin'],
      'imp: --scope must be one of read, exec, manage',
    ],
    [
      ['approve', 'ABCD-EFGH', '--imps', 'd*v'],
      'imp: --imps takes imp names, or a name prefix and a trailing *, such as dev-*; not d*v',
    ],
  ];

  for (const [rawArgs, message] of cases) {
    process.exitCode = 0;

    await runCommand(oauthCommand, { rawArgs: [...rawArgs] });

    expect(stderr).toHaveBeenCalledWith(message);
    expect(process.exitCode).toBe(2);
  }
});

test('gc --secret-files without --orphans fails before it deletes anything', async () => {
  const stderr = setupStderr();

  await runCommand(gcCommand, { rawArgs: ['--secret-files'] });

  expect(stderr).toHaveBeenCalledWith('imp: --secret-files goes with --orphans');
  expect(process.exitCode).toBe(2);
});
