import { expect, mock, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateLegacyConfig } from './update-legacy-config';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'impz-legacy-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it moves the saved hosts and the token file from the old directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'config.json'), '{"current":null,"hosts":{}}\n');
  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');

  const warn = mock();

  updateLegacyConfig({ XDG_CONFIG_HOME: ctx.dir }, warn);

  expect(readFileSync(join(ctx.dir, 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );

  expect(readFileSync(join(ctx.dir, 'impz', 'token'), 'utf8')).toBe('file-token\n');
  expect(existsSync(join(ctx.dir, 'imp'))).toBeFalse();
  expect(statSync(join(ctx.dir, 'impz')).mode & 0o777).toBe(0o700);

  expect(warn.mock.calls).toStrictEqual([
    [
      `impz: moved ${join(ctx.dir, 'imp', 'config.json')} to ${join(ctx.dir, 'impz', 'config.json')}`,
    ],
    [`impz: moved ${join(ctx.dir, 'imp', 'token')} to ${join(ctx.dir, 'impz', 'token')}`],
  ]);
});

test('it never moves over a directory impz has already', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'config.json'), 'old\n');
  mkdirSync(join(ctx.dir, 'impz'));
  writeFileSync(join(ctx.dir, 'impz', 'config.json'), 'new\n');

  const warn = mock();

  updateLegacyConfig({ XDG_CONFIG_HOME: ctx.dir }, warn);

  expect(readFileSync(join(ctx.dir, 'impz', 'config.json'), 'utf8')).toBe('new\n');
  expect(readFileSync(join(ctx.dir, 'imp', 'config.json'), 'utf8')).toBe('old\n');
  expect(warn).not.toHaveBeenCalled();
});

test('it makes no directory when the old one holds neither file', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'notes.txt'), 'another tool\n');
  updateLegacyConfig({ XDG_CONFIG_HOME: ctx.dir }, mock());

  expect(readdirSync(ctx.dir)).toStrictEqual(['imp']);
});

test('it leaves the old directory with whatever else it holds', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'token'), 'file-token\n');
  writeFileSync(join(ctx.dir, 'imp', 'notes.txt'), 'kept\n');
  updateLegacyConfig({ XDG_CONFIG_HOME: ctx.dir }, mock());

  expect(readdirSync(join(ctx.dir, 'imp'))).toStrictEqual(['notes.txt']);
  expect(readFileSync(join(ctx.dir, 'impz', 'token'), 'utf8')).toBe('file-token\n');
});

test('it moves a relative symlink that still resolves after the move', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'dotfiles'));
  writeFileSync(join(ctx.dir, 'dotfiles', 'config.json'), '{"current":null,"hosts":{}}\n');
  mkdirSync(join(ctx.dir, 'imp'));
  symlinkSync('../dotfiles/config.json', join(ctx.dir, 'imp', 'config.json'));
  updateLegacyConfig({ XDG_CONFIG_HOME: ctx.dir }, mock());

  expect(readlinkSync(join(ctx.dir, 'impz', 'config.json'))).toBe('../dotfiles/config.json');

  expect(readFileSync(join(ctx.dir, 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});

test('it points a moved symlink at a file that stays in the old directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'hosts.json'), '{"current":null,"hosts":{}}\n');
  symlinkSync('hosts.json', join(ctx.dir, 'imp', 'config.json'));
  updateLegacyConfig({ XDG_CONFIG_HOME: ctx.dir }, mock());

  expect(readlinkSync(join(ctx.dir, 'impz', 'config.json'))).toBe('../imp/hosts.json');

  expect(readFileSync(join(ctx.dir, 'impz', 'config.json'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});

test('it points a moved symlink at the other moved file', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'imp'));
  writeFileSync(join(ctx.dir, 'imp', 'config.json'), '{"current":null,"hosts":{}}\n');
  symlinkSync('./config.json', join(ctx.dir, 'imp', 'token'));
  updateLegacyConfig({ XDG_CONFIG_HOME: ctx.dir }, mock());

  expect(readlinkSync(join(ctx.dir, 'impz', 'token'))).toBe('config.json');

  expect(readFileSync(join(ctx.dir, 'impz', 'token'), 'utf8')).toBe(
    '{"current":null,"hosts":{}}\n',
  );
});

test('it keeps an absolute symlink as it was', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'root-token'), 'root\n');
  mkdirSync(join(ctx.dir, 'imp'));
  symlinkSync(join(ctx.dir, 'root-token'), join(ctx.dir, 'imp', 'token'));
  updateLegacyConfig({ XDG_CONFIG_HOME: ctx.dir }, mock());

  expect(readlinkSync(join(ctx.dir, 'impz', 'token'))).toBe(join(ctx.dir, 'root-token'));
});
