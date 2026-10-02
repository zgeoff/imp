import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCliConfig } from './cli-config';
import type { CliConfig } from './cli-config';
import { writeHostConfig } from './host-store';

interface Setup {
  readonly current?: string;
  readonly tokenFile?: boolean;
}

const HOSTS = {
  home: { url: 'https://home.example', token: 'home-token' },
  work: { url: 'https://work.example', token: 'work-token' },
};

function setupTest(setup: Setup = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-cli-'));

  writeHostConfig({ XDG_CONFIG_HOME: dir }, { current: setup.current ?? null, hosts: HOSTS });

  if (setup.tokenFile === true) {
    writeFileSync(join(dir, 'imp', 'token'), 'file-token\n');
  }

  return {
    dir,
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const LOCAL = 'http://localhost:7070';
const OTHER = 'http://other:7070';

interface Case {
  readonly name: string;
  readonly setup: Setup;
  readonly env: Readonly<Record<string, string>>;
  readonly flag?: string;
  readonly want: CliConfig;
}

// Every source of a URL against every source of a token: the pair always
// comes from one place, and a saved token never follows IMP_URL elsewhere.
const CASES: readonly Case[] = [
  {
    name: 'nothing set: the local impd, no token',
    setup: {},
    env: {},
    want: { url: LOCAL, token: null, host: null },
  },
  {
    name: 'the old token file goes with the local impd',
    setup: { tokenFile: true },
    env: {},
    want: { url: LOCAL, token: 'file-token', host: null },
  },
  {
    name: 'IMP_TOKEN alone overrides the token file',
    setup: { tokenFile: true },
    env: { IMP_TOKEN: 'env-token' },
    want: { url: LOCAL, token: 'env-token', host: null },
  },
  {
    name: 'the current host wins over the token file',
    setup: { current: 'home', tokenFile: true },
    env: {},
    want: { url: HOSTS.home.url, token: 'home-token', host: 'home' },
  },
  {
    name: "IMP_TOKEN alone overrides the current host's token",
    setup: { current: 'home' },
    env: { IMP_TOKEN: 'env-token' },
    want: { url: HOSTS.home.url, token: 'env-token', host: 'home' },
  },
  {
    name: "IMP_URL never takes the current host's token",
    setup: { current: 'home', tokenFile: true },
    env: { IMP_URL: OTHER },
    want: { url: OTHER, token: null, host: null },
  },
  {
    name: 'IMP_URL never takes the token file',
    setup: { tokenFile: true },
    env: { IMP_URL: OTHER },
    want: { url: OTHER, token: null, host: null },
  },
  {
    name: 'IMP_URL with IMP_TOKEN pairs them',
    setup: { current: 'home' },
    env: { IMP_URL: OTHER, IMP_TOKEN: 'env-token' },
    want: { url: OTHER, token: 'env-token', host: null },
  },
  {
    name: 'IMP_HOST wins over IMP_URL and the current host, and ignores IMP_TOKEN',
    setup: { current: 'home' },
    env: { IMP_HOST: 'work', IMP_URL: OTHER, IMP_TOKEN: 'env-token' },
    want: { url: HOSTS.work.url, token: 'work-token', host: 'work' },
  },
  {
    name: '--host wins over IMP_HOST, and ignores IMP_TOKEN',
    setup: { current: 'home' },
    env: { IMP_HOST: 'home', IMP_URL: OTHER, IMP_TOKEN: 'env-token' },
    flag: 'work',
    want: { url: HOSTS.work.url, token: 'work-token', host: 'work' },
  },
  {
    name: 'empty variables count as unset',
    setup: { current: 'home' },
    env: { IMP_HOST: '', IMP_URL: '', IMP_TOKEN: '' },
    want: { url: HOSTS.home.url, token: 'home-token', host: 'home' },
  },
];

for (const testCase of CASES) {
  test(testCase.name, () => {
    using ctx = setupTest(testCase.setup);

    const config = loadCliConfig(
      { XDG_CONFIG_HOME: ctx.dir, ...testCase.env },
      testCase.flag ?? null,
    );

    expect(config).toEqual(testCase.want);
  });
}

test('a current host that is no longer saved is an error, not the local impd', () => {
  using ctx = setupTest({ current: 'gone' });

  expect(() => loadCliConfig({ XDG_CONFIG_HOME: ctx.dir }, null)).toThrow('no saved host gone');
});

test('an IMP_HOST that is not a host name is a usage error', () => {
  using ctx = setupTest();

  expect(() => loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_HOST: 'a b' }, null)).toThrow(
    'not a host name: a b',
  );
});

test('IMP_TOKEN next to a named host gets a note on stderr', () => {
  using ctx = setupTest();

  const stderr = spyOn(console, 'error').mockImplementation(() => {
    // captured
  });

  loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_TOKEN: 'env-token' }, 'work');

  expect(stderr).toHaveBeenCalledWith('imp: note: IMP_TOKEN is ignored; work uses its saved token');

  stderr.mockRestore();
});

test('an unknown --host or IMP_HOST is a usage error', () => {
  using ctx = setupTest();

  expect(() => loadCliConfig({ XDG_CONFIG_HOME: ctx.dir }, 'nope')).toThrow(
    'no saved host nope (see imp host ls, or imp login <url> --name nope)',
  );

  expect(() => loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_HOST: 'nope' }, null)).toThrow(
    'no saved host nope',
  );
});

test('an IMP_HOST that is a URL points at IMP_URL', () => {
  using ctx = setupTest();

  expect(() =>
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_HOST: 'https://home.example' }, null),
  ).toThrow('IMP_HOST names a saved host; use IMP_URL');
});

test('an IMP_URL that is not http is a usage error', () => {
  using ctx = setupTest();

  expect(() =>
    loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_URL: 'localhost:7070' }, null),
  ).toThrow('IMP_URL is not an http(s) URL: localhost:7070');
});

test('a damaged config.json is an error, but IMP_URL does not read it', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'), { recursive: true });
  writeFileSync(join(ctx.dir, 'imp', 'config.json'), '{ not json');

  expect(() => loadCliConfig({ XDG_CONFIG_HOME: ctx.dir }, null)).toThrow('is not valid JSON');
  expect(loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_URL: OTHER }, null).url).toBe(OTHER);
});
