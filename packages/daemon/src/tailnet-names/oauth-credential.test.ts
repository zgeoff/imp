import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOAuthCredential } from './oauth-credential';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-oauth-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it reads the client from an owner-only file', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'oauth.json');

  writeFileSync(path, JSON.stringify({ clientId: 'kExample', clientSecret: 'secret' }), {
    mode: 0o600,
  });

  expect(readOAuthCredential(path)).toStrictEqual({ clientId: 'kExample', clientSecret: 'secret' });
});

test('it refuses a file others can read, naming its mode and not its secret', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'oauth.json');

  writeFileSync(
    path,
    JSON.stringify({ clientId: 'kExample', clientSecret: 'tskey-client-kExample-SECRETVALUE' }),
    { mode: 0o644 },
  );

  expect(() => readOAuthCredential(path)).toThrowWithMessage(
    Error,
    `${path} is mode 644; it holds a secret, so make it 0600`,
  );
});

test('it refuses a file it cannot parse, without its secret', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'oauth.json');

  writeFileSync(path, '{"clientSecret": "tskey-client-kExample-SECRETVALUE"', { mode: 0o600 });

  expect(() => readOAuthCredential(path)).toThrowWithMessage(
    Error,
    `${path} must be JSON with a clientId and a clientSecret`,
  );
});

test('it refuses a file with an empty client secret', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'oauth.json');

  writeFileSync(path, JSON.stringify({ clientId: 'kExample', clientSecret: '' }), { mode: 0o600 });

  expect(() => readOAuthCredential(path)).toThrowWithMessage(
    Error,
    `${path} must be JSON with a clientId and a clientSecret`,
  );
});

test('it refuses a file that is not there', () => {
  const ctx = setupTest();

  expect(() => readOAuthCredential(join(ctx.dir, 'oauth.json'))).toThrow(/^ENOENT/v);
});
