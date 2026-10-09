import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDnsToken } from './dns-token';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-dns-token-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { path: join(dir, 'token') };
}

test('it reads a token from the env as its value', async () => {
  const token = createDnsToken({ kind: 'value', value: 'cf-secret-value' }, () => 5);

  const value = await token.read();

  expect(value).toBe('cf-secret-value');
});

test('it has no check for a token from the env', () => {
  const token = createDnsToken({ kind: 'value', value: 'cf-secret-value' }, () => 5);

  expect(token.check).toBeNull();
});

test('it reads the token file at each use, so a rotated token works at once', async () => {
  const ctx = await setupTest();

  const token = createDnsToken({ kind: 'file', path: ctx.path }, () => 1000);

  await writeFile(ctx.path, 'cf-secret-value');

  await token.read();

  await writeFile(ctx.path, 'cf-rotated');

  const value = await token.read();

  expect(value).toBe('cf-rotated');
});

test('it trims the whitespace around the token in the file', async () => {
  const ctx = await setupTest();

  const token = createDnsToken({ kind: 'file', path: ctx.path }, () => 1000);

  await writeFile(ctx.path, ' cf-secret-value\n');

  const value = await token.read();

  expect(value).toBe('cf-secret-value');
});

test('it rejects a missing file, naming the path and the error code', async () => {
  const ctx = await setupTest();

  const token = createDnsToken({ kind: 'file', path: ctx.path }, () => 1000);

  expect(token.read()).rejects.toThrowWithMessage(
    Error,
    `cannot read the DNS API token from ${ctx.path}: ENOENT`,
  );
});

test('it calls a read failure with no error code unreadable', () => {
  const token = createDnsToken(
    { kind: 'file', path: '/run/imp/dns/token' },
    () => 1000,
    () => Promise.reject(new Error('the disk went away')),
  );

  expect(token.read()).rejects.toThrowWithMessage(
    Error,
    'cannot read the DNS API token from /run/imp/dns/token: unreadable',
  );
});

test.each([
  ['an empty file', ''],
  ['a file of whitespace', ' \n\n'],
])('it rejects %s as holding no token', async (_label, content) => {
  const ctx = await setupTest();

  const token = createDnsToken({ kind: 'file', path: ctx.path }, () => 1000);

  await writeFile(ctx.path, content);

  expect(token.read()).rejects.toThrowWithMessage(
    Error,
    `the DNS API token file ${ctx.path} is empty`,
  );
});

test.each([
  ['a pasted env line', 'IMP_DNS_API_TOKEN=cf-secret-value'],
  ['two tokens', 'cf-secret-value cf-secret-value'],
  ['two lines', 'cf-secret-value\nb'],
  ['a NUL byte', 'cf-secret-value\u0000'],
  ['a non-ASCII letter', 'cf-secret-valueé'],
  ['UTF-16 text', new Uint8Array(Buffer.from('cf-secret-value', 'utf16le'))],
])('it rejects a token file of %s without the token in the message', async (_label, content) => {
  const ctx = await setupTest();

  const token = createDnsToken({ kind: 'file', path: ctx.path }, () => 1000);

  await writeFile(ctx.path, content);

  expect(token.read()).rejects.toThrowWithMessage(
    Error,
    `the DNS API token file ${ctx.path} holds characters no token has, such as whitespace, '=' or a NUL byte`,
  );
});

test('it checks a token file with a bad character without the token in the error', async () => {
  const ctx = await setupTest();

  const token = createDnsToken({ kind: 'file', path: ctx.path }, () => 1000);

  await writeFile(ctx.path, 'IMP_DNS_API_TOKEN=cf-secret-value');

  const status = await token.check?.();

  expect(status).toStrictEqual({
    isOk: false,
    error: `the DNS API token file ${ctx.path} holds characters no token has, such as whitespace, '=' or a NUL byte`,
    at: 1000,
  });
});

test('it checks a missing token file as failed, at the time it checked', async () => {
  const ctx = await setupTest();

  const token = createDnsToken({ kind: 'file', path: ctx.path }, () => 1000);

  const status = await token.check?.();

  expect(status).toStrictEqual({
    isOk: false,
    error: `cannot read the DNS API token from ${ctx.path}: ENOENT`,
    at: 1000,
  });
});

test('it reads the file again at each check, so a check shows the token as it is now', async () => {
  const ctx = await setupTest();

  const clock = { now: 1000 };
  const token = createDnsToken({ kind: 'file', path: ctx.path }, () => clock.now);

  await token.check?.();

  await writeFile(ctx.path, 'cf-secret-value');

  clock.now = 2000;

  const status = await token.check?.();

  expect(status).toStrictEqual({ isOk: true, error: null, at: 2000 });
});
