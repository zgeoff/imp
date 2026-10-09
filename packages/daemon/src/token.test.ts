import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateToken } from './token';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-token-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it makes a token of 32 random bytes in base64url on first start', () => {
  const ctx = setupTest();
  const token = loadOrCreateToken(ctx.dir);

  expect(token).toMatch(/^[\w-]{43}$/);
});

test('it makes a different token for each new data dir', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'a'));
  mkdirSync(join(ctx.dir, 'b'));

  const first = loadOrCreateToken(join(ctx.dir, 'a'));
  const second = loadOrCreateToken(join(ctx.dir, 'b'));

  expect(second).not.toBe(first);
});

test('it keeps the token it makes in a file the owner alone may read', () => {
  const ctx = setupTest();
  const token = loadOrCreateToken(ctx.dir);

  expect(readFileSync(join(ctx.dir, 'token'), 'utf8')).toBe(`${token}\n`);
  expect(statSync(join(ctx.dir, 'token')).mode & 0o777).toBe(0o600);
});

test('it reads back the token it made on a later start', () => {
  const ctx = setupTest();
  const made = loadOrCreateToken(ctx.dir);

  expect(loadOrCreateToken(ctx.dir)).toBe(made);
});

test('it reads a token file another process wrote, without its surrounding whitespace', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'token'), '  operator-token \n');

  expect(loadOrCreateToken(ctx.dir)).toBe('operator-token');
});

test('it throws when the data dir does not exist', () => {
  const ctx = setupTest();

  expect(() => loadOrCreateToken(join(ctx.dir, 'missing'))).toThrow(/ENOENT/);
});
