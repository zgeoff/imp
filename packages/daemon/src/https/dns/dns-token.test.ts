import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readErrorMessage } from '../../read-error-message';
import { readRejection } from '../../read-rejection';
import { createDnsToken } from './dns-token';

const SECRET = 'cf-secret-value';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-dns-token-'));
  const path = join(dir, 'token');
  const clock = { now: 1000 };

  return {
    path,
    clock,
    token: createDnsToken({ kind: 'file', path }, () => clock.now),
    write: (content: string) => {
      writeFileSync(path, content);
    },
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function readFailure(read: () => Promise<string>): Promise<string> {
  const error = await readRejection(read());

  return readErrorMessage(error);
}

test('a token from the env is the value, always', async () => {
  const token = createDnsToken({ kind: 'value', value: SECRET }, () => 5);

  expect(token.readStatus()).toBeNull();

  const value = await token.read();

  expect(value).toBe(SECRET);
  expect(token.readStatus()).toEqual({ isOk: true, error: null, at: 5 });
});

test('a token file is read at each use, so a new token works at once', async () => {
  using ctx = setup();

  ctx.write(`${SECRET}\n`);

  const first = await ctx.token.read();

  ctx.write('cf-rotated');

  const second = await ctx.token.read();

  expect([first, second]).toEqual([SECRET, 'cf-rotated']);
  expect(ctx.token.readStatus()).toEqual({ isOk: true, error: null, at: 1000 });
});

test('a missing file names the path and the error code', async () => {
  using ctx = setup();

  const message = await readFailure(ctx.token.read);

  expect(message).toBe(`cannot read the DNS API token from ${ctx.path}: ENOENT`);

  expect(ctx.token.readStatus()).toEqual({
    isOk: false,
    error: `cannot read the DNS API token from ${ctx.path}: ENOENT`,
    at: 1000,
  });
});

test('an empty file, or one of whitespace, holds no token', async () => {
  using ctx = setup();

  for (const content of ['', ' \n\n']) {
    ctx.write(content);

    const message = await readFailure(ctx.token.read);

    expect(message).toBe(`the DNS API token file ${ctx.path} is empty`);
  }
});

test('whitespace or = inside the token is refused, without the token in the message', async () => {
  using ctx = setup();

  for (const content of [`IMP_DNS_API_TOKEN=${SECRET}`, `${SECRET} ${SECRET}`, `${SECRET}\nb`]) {
    ctx.write(content);

    const message = await readFailure(ctx.token.read);

    expect(message).toBe(
      `the DNS API token file ${ctx.path} holds whitespace or '=' inside the token`,
    );

    expect(message).not.toContain(SECRET);
    expect(ctx.token.readStatus()?.error).not.toContain(SECRET);
  }
});

test('a failure, then a good read: the status follows the last read', async () => {
  using ctx = setup();

  await readRejection(ctx.token.read());

  expect(ctx.token.readStatus()?.isOk).toBe(false);

  ctx.write(SECRET);

  ctx.clock.now = 2000;

  const token = await ctx.token.read();

  expect(token).toBe(SECRET);
  expect(ctx.token.readStatus()).toEqual({ isOk: true, error: null, at: 2000 });
});
