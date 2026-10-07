import { expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCliConfig } from './cli-config';
import { writeHostConfig } from './host-store';
import { UsageError } from './usage-error';

function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-cli-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    dir,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

// Every source of a URL against every source of a token: the pair always
// comes from one place, and a saved token never follows IMP_URL elsewhere.

test('it calls the local impd with no token when nothing is set', () => {
  using ctx = setupTest();

  expect(loadCliConfig({ XDG_CONFIG_HOME: ctx.dir }, null)).toStrictEqual({
    url: 'http://localhost:7070',
    token: null,
    host: null,
  });
});

test('it pairs the old token file with the local impd', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');

  expect(loadCliConfig({ XDG_CONFIG_HOME: ctx.dir }, null)).toStrictEqual({
    url: 'http://localhost:7070',
    token: 'file-token',
    host: null,
  });
});

test('it takes IMP_TOKEN alone over the token file', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');

  expect(loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_TOKEN: 'env-token' }, null)).toStrictEqual({
    url: 'http://localhost:7070',
    token: 'env-token',
    host: null,
  });
});

test('it takes the current host over the token file', () => {
  using ctx = setupTest();

  writeHostConfig(
    { XDG_CONFIG_HOME: ctx.dir },
    { current: 'home', hosts: { home: { url: 'https://home.example', token: 'home-token' } } },
  );

  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');

  expect(loadCliConfig({ XDG_CONFIG_HOME: ctx.dir }, null)).toStrictEqual({
    url: 'https://home.example',
    token: 'home-token',
    host: 'home',
  });
});

test("it takes IMP_TOKEN alone over the current host's token", () => {
  using ctx = setupTest();

  writeHostConfig(
    { XDG_CONFIG_HOME: ctx.dir },
    { current: 'home', hosts: { home: { url: 'https://home.example', token: 'home-token' } } },
  );

  expect(loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_TOKEN: 'env-token' }, null)).toStrictEqual({
    url: 'https://home.example',
    token: 'env-token',
    host: 'home',
  });
});

test("it never sends the current host's token to IMP_URL", () => {
  using ctx = setupTest();

  writeHostConfig(
    { XDG_CONFIG_HOME: ctx.dir },
    { current: 'home', hosts: { home: { url: 'https://home.example', token: 'home-token' } } },
  );

  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');

  expect(
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_URL: 'http://other:7070' }, null),
  ).toStrictEqual({ url: 'http://other:7070', token: null, host: null });
});

test('it never sends the token file to IMP_URL', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');

  expect(
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_URL: 'http://other:7070' }, null),
  ).toStrictEqual({ url: 'http://other:7070', token: null, host: null });
});

test('it pairs IMP_URL with IMP_TOKEN', () => {
  using ctx = setupTest();

  writeHostConfig(
    { XDG_CONFIG_HOME: ctx.dir },
    { current: 'home', hosts: { home: { url: 'https://home.example', token: 'home-token' } } },
  );

  expect(
    loadCliConfig(
      { XDG_CONFIG_HOME: ctx.dir, IMP_URL: 'http://other:7070', IMP_TOKEN: 'env-token' },
      null,
    ),
  ).toStrictEqual({ url: 'http://other:7070', token: 'env-token', host: null });
});

test('it takes IMP_HOST over IMP_URL and the current host, with its saved token', () => {
  using ctx = setupTest();

  writeHostConfig(
    { XDG_CONFIG_HOME: ctx.dir },
    {
      current: 'home',
      hosts: {
        home: { url: 'https://home.example', token: 'home-token' },
        work: { url: 'https://work.example', token: 'work-token' },
      },
    },
  );

  const config = loadCliConfig(
    {
      XDG_CONFIG_HOME: ctx.dir,
      IMP_HOST: 'work',
      IMP_URL: 'http://other:7070',
      IMP_TOKEN: 'env-token',
    },
    null,
    () => {
      // the IMP_TOKEN note has a test of its own
    },
  );

  expect(config).toStrictEqual({ url: 'https://work.example', token: 'work-token', host: 'work' });
});

test('it takes --host over IMP_HOST, with its saved token', () => {
  using ctx = setupTest();

  writeHostConfig(
    { XDG_CONFIG_HOME: ctx.dir },
    {
      current: 'home',
      hosts: {
        home: { url: 'https://home.example', token: 'home-token' },
        work: { url: 'https://work.example', token: 'work-token' },
      },
    },
  );

  const config = loadCliConfig(
    {
      XDG_CONFIG_HOME: ctx.dir,
      IMP_HOST: 'home',
      IMP_URL: 'http://other:7070',
      IMP_TOKEN: 'env-token',
    },
    'work',
    () => {
      // the IMP_TOKEN note has a test of its own
    },
  );

  expect(config).toStrictEqual({ url: 'https://work.example', token: 'work-token', host: 'work' });
});

test('it reads empty variables as unset', () => {
  using ctx = setupTest();

  writeHostConfig(
    { XDG_CONFIG_HOME: ctx.dir },
    { current: 'home', hosts: { home: { url: 'https://home.example', token: 'home-token' } } },
  );

  expect(
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_HOST: '', IMP_URL: '', IMP_TOKEN: '' }, null),
  ).toStrictEqual({ url: 'https://home.example', token: 'home-token', host: 'home' });
});

test('it rejects a current host that is no longer saved instead of calling the local impd', () => {
  using ctx = setupTest();

  writeHostConfig({ XDG_CONFIG_HOME: ctx.dir }, { current: 'gone', hosts: {} });

  expect(() => loadCliConfig({ XDG_CONFIG_HOME: ctx.dir }, null)).toThrowWithMessage(
    UsageError,
    'no saved host gone (see imp host ls, or imp login <url> --name gone)',
  );
});

test('it rejects an IMP_HOST that is not a host name', () => {
  using ctx = setupTest();

  expect(() =>
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_HOST: 'a b' }, null),
  ).toThrowWithMessage(UsageError, /^not a host name: a b /u);
});

test('it notes on stderr that IMP_TOKEN is ignored beside a named host', () => {
  using ctx = setupTest();

  const warn = mock<(line: string) => void>();

  writeHostConfig(
    { XDG_CONFIG_HOME: ctx.dir },
    { current: null, hosts: { work: { url: 'https://work.example', token: 'work-token' } } },
  );

  loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_TOKEN: 'env-token' }, 'work', warn);

  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'imp: note: IMP_TOKEN is ignored; work uses its saved token',
  );
});

test('it rejects an unknown --host', () => {
  using ctx = setupTest();

  expect(() => loadCliConfig({ XDG_CONFIG_HOME: ctx.dir }, 'nope')).toThrowWithMessage(
    UsageError,
    'no saved host nope (see imp host ls, or imp login <url> --name nope)',
  );
});

test('it rejects an unknown IMP_HOST', () => {
  using ctx = setupTest();

  expect(() =>
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_HOST: 'nope' }, null),
  ).toThrowWithMessage(
    UsageError,
    'no saved host nope (see imp host ls, or imp login <url> --name nope)',
  );
});

test('it points an IMP_HOST that is a URL at IMP_URL', () => {
  using ctx = setupTest();

  expect(() =>
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_HOST: 'https://home.example' }, null),
  ).toThrowWithMessage(UsageError, 'IMP_HOST names a saved host; use IMP_URL');
});

test('it rejects an IMP_URL that is not http', () => {
  using ctx = setupTest();

  expect(() =>
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_URL: 'localhost:7070' }, null),
  ).toThrowWithMessage(UsageError, 'IMP_URL is not an http(s) URL: localhost:7070');
});

test('it rejects a damaged config.json', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'config.json'), '{ not json', { mode: 0o600 });

  expect(() => loadCliConfig({ XDG_CONFIG_HOME: ctx.dir }, null)).toThrowWithMessage(
    UsageError,
    `${join(ctx.dir, 'imp', 'config.json')} is not valid JSON; fix or remove it`,
  );
});

test('it never reads a damaged config.json when IMP_URL is set', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'config.json'), '{ not json', { mode: 0o600 });

  expect(
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_URL: 'http://other:7070' }, null),
  ).toStrictEqual({ url: 'http://other:7070', token: null, host: null });
});
