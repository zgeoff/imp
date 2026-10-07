import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostConfig, resolveConfigPath, writeHostConfig } from '../host-store';
import { runCli } from '../test-utils/start-cli';
import { startStubImpd } from '../test-utils/start-stub-impd';

// The CLI runs as a user runs it, against an impd it reaches over loopback.

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'imp-login-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  // the CLI's home: config.json lives under XDG_CONFIG_HOME
  const env = { HOME: dir, XDG_CONFIG_HOME: dir };

  return { env, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it saves the host as current when impd accepts the token', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({ token: 'login-token' });

  const login = await runCli({
    args: ['login', impd.url, '--name', 'home'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: `logged in to ${impd.url} as home, now the current host\n`,
    stderr: '',
    code: 0,
  });

  expect(impd.calls).toStrictEqual([
    { path: 'system/info', authorization: 'Bearer login-token', input: undefined },
  ]);

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: 'home',
    hosts: { home: { url: impd.url, token: 'login-token' } },
  });
});

test('it lists the saved hosts without their tokens', async () => {
  await using ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'login-token' } },
  });

  const listed = await runCli({ args: ['hosts'], env: ctx.env });

  expect(listed).toStrictEqual({
    stdout: '   NAME  URL                   TOKEN\n*  home  https://home.example  saved\n',
    stderr: '',
    code: 0,
  });
});

test('it saves nothing when impd refuses the token', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({ token: 'login-token' });

  const login = await runCli({ args: ['login', impd.url], env: ctx.env, stdin: 'wrong\n' });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: `imp: ${impd.url} refused the token; nothing saved\n`,
    code: 1,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('it saves nothing when the token is empty', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({ token: 'login-token' });

  const login = await runCli({ args: ['login', impd.url], env: ctx.env, stdin: '\n' });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: 'imp: no token given; nothing saved\n',
    code: 2,
  });

  expect(impd.calls).toStrictEqual([]);
  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('it saves nothing when impd is out of reach', async () => {
  await using ctx = await setupTest();

  const login: unknown = await runCli({
    args: ['login', 'http://127.0.0.1:1'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(
      /^imp: cannot check the token with http:\/\/127\.0\.0\.1:1: .+; nothing saved\n$/u,
    ) as unknown,
    code: 1,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('it saves without asking impd and warns of plain http under --no-verify', async () => {
  await using ctx = await setupTest();

  const login = await runCli({
    args: ['login', 'http://imp.example:7070', '--no-verify'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: 'logged in to http://imp.example:7070 as imp, now the current host\n',
    stderr:
      'imp: warning: http://imp.example:7070 is plain http; the token crosses the network unencrypted\n',
    code: 0,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: 'imp',
    hosts: { imp: { url: 'http://imp.example:7070', token: 'login-token' } },
  });
});

test('it leaves a damaged config.json as it was and asks impd nothing on login', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({ token: 'login-token' });

  writeHostConfig(ctx.env, { current: null, hosts: {} });

  await writeFile(resolveConfigPath(ctx.env), '{ damaged', { mode: 0o600 });

  const login: unknown = await runCli({
    args: ['login', impd.url],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/is not valid JSON; fix or remove it\n$/u) as unknown,
    code: 2,
  });

  const config = await readFile(resolveConfigPath(ctx.env), 'utf8');

  expect(config).toBe('{ damaged');
  expect(impd.calls).toStrictEqual([]);
});

test('it makes a saved host current on host use', async () => {
  await using ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: {
      home: { url: 'https://home.example', token: 'home-token' },
      work: { url: 'https://work.example', token: 'work-token' },
    },
  });

  const used = await runCli({ args: ['host', 'use', 'work'], env: ctx.env });

  expect(used.code).toBe(0);
  expect(readHostConfig(ctx.env).current).toBe('work');
});

test('it refuses a host use of a host it has not saved', async () => {
  await using ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'home-token' } },
  });

  const used = await runCli({ args: ['host', 'use', 'nope'], env: ctx.env });

  expect(used).toStrictEqual({
    stdout: '',
    stderr: 'imp: no saved host nope (see imp host ls)\n',
    code: 2,
  });

  expect(readHostConfig(ctx.env).current).toBe('home');
});

test('it forgets the current host and clears current on host rm', async () => {
  await using ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'work',
    hosts: {
      home: { url: 'https://home.example', token: 'home-token' },
      work: { url: 'https://work.example', token: 'work-token' },
    },
  });

  const removed = await runCli({ args: ['host', 'rm', 'work'], env: ctx.env });

  expect(removed.code).toBe(0);

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: null,
    hosts: { home: { url: 'https://home.example', token: 'home-token' } },
  });
});

test('it sends the saved token of --host and names the host in a 401', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({ token: 'login-token' });

  writeHostConfig(ctx.env, { current: null, hosts: { work: { url: impd.url, token: 'stale' } } });

  const listed = await runCli({
    args: ['--host', 'work', 'ls'],
    env: { ...ctx.env, IMP_TOKEN: 'ignored' },
  });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: [
      'imp: note: IMP_TOKEN is ignored; work uses its saved token\n',
      `imp: unauthorized: work (${impd.url}) refused the token; run imp login ${impd.url} --name work\n`,
    ].join(''),
    code: 1,
  });

  expect(impd.calls).toStrictEqual([
    { path: 'imps/list', authorization: 'Bearer stale', input: undefined },
  ]);
});

test('it carries the saved token of --host on exec’s socket and its follow-up check', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({ token: 'login-token' });

  writeHostConfig(ctx.env, { current: null, hosts: { work: { url: impd.url, token: 'stale' } } });

  const exec = await runCli({
    args: ['--host', 'work', 'exec', 'box', '--', 'true'],
    env: ctx.env,
  });

  expect(exec).toStrictEqual({
    stdout: '',
    stderr: `imp: unauthorized: work (${impd.url}) refused the token; run imp login ${impd.url} --name work\n`,
    code: 255,
  });

  expect(impd.calls).not.toBeEmpty();

  expect(impd.calls).toSatisfyAll(
    (call: Readonly<{ authorization: string | null }>) => call.authorization === 'Bearer stale',
  );
});

test('it refuses --host without a saved host name', async () => {
  await using ctx = await setupTest();

  const listed = await runCli({ args: ['ls', '--host'], env: ctx.env });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: 'imp: --host needs a saved host name (see imp host ls)\n',
    code: 2,
  });
});

test('it prints the version with --host and no saved host', async () => {
  await using ctx = await setupTest();

  const version: unknown = await runCli({ args: ['--host', 'work', '--version'], env: ctx.env });

  expect(version).toStrictEqual({
    stdout: expect.stringMatching(/^\d+\.\d+\.\d+\n$/u) as unknown,
    stderr: '',
    code: 0,
  });
});

test('it prints the help with --host and no saved host', async () => {
  await using ctx = await setupTest();

  const help: unknown = await runCli({ args: ['--host', 'work', '--help'], env: ctx.env });

  expect(help).toStrictEqual({
    stdout: expect.stringContaining('--host') as unknown,
    stderr: '',
    code: 0,
  });
});

test('it prints one line, not a stack, when exec cannot read config.json', async () => {
  await using ctx = await setupTest();

  await mkdir(resolveConfigPath(ctx.env), { recursive: true });

  const exec: unknown = await runCli({ args: ['exec', 'box', '--', 'true'], env: ctx.env });

  expect(exec).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/^imp: [^\n]*EISDIR[^\n]*\n$/u) as unknown,
    code: 255,
  });
});
