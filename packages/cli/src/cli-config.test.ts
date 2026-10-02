import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCliConfig } from './cli-config';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-cli-'));

  return {
    dir,
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('it defaults to the local impd with no token', () => {
  using ctx = setupTest();

  expect(loadCliConfig({ XDG_CONFIG_HOME: ctx.dir })).toEqual({
    url: 'http://localhost:7070',
    token: null,
  });
});

test('it treats an empty IMP_URL as unset', () => {
  using ctx = setupTest();

  expect(loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_URL: '' }).url).toBe(
    'http://localhost:7070',
  );
});

test('it reads the token file and lets IMP_TOKEN override it', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'token'), 'from-file\n');

  const fromFile = loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_URL: 'http://imp:7070' });
  const fromEnv = loadCliConfig({ XDG_CONFIG_HOME: ctx.dir, IMP_TOKEN: 'from-env' });

  expect(fromFile).toEqual({ url: 'http://imp:7070', token: 'from-file' });
  expect(fromEnv.token).toBe('from-env');
});
