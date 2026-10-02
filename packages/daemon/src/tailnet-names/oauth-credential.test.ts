import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateHostId } from './host-id';
import { readOAuthCredential } from './oauth-credential';

const SECRET = 'tskey-client-kExample-SECRETVALUE';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-names-'));

  return {
    dir,
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('it reads the client from an owner-only file', () => {
  using ctx = setupTest();

  const path = join(ctx.dir, 'oauth.json');

  writeFileSync(path, JSON.stringify({ clientId: 'kExample', clientSecret: SECRET }), {
    mode: 0o600,
  });

  expect(readOAuthCredential(path)).toEqual({ clientId: 'kExample', clientSecret: SECRET });
});

test('a file others can read, or one it cannot parse, is refused without its secret', () => {
  using ctx = setupTest();

  const open = join(ctx.dir, 'open.json');
  const broken = join(ctx.dir, 'broken.json');

  writeFileSync(open, JSON.stringify({ clientId: 'kExample', clientSecret: SECRET }), {
    mode: 0o644,
  });

  writeFileSync(broken, `{"clientSecret": "${SECRET}"`, { mode: 0o600 });

  expect(() => readOAuthCredential(open)).toThrow(`${open} is mode 644`);
  expect(() => readOAuthCredential(broken)).toThrow('must be JSON with a clientId');

  for (const path of [open, broken]) {
    try {
      readOAuthCredential(path);
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  }
});

test('the host ID is made once, owner-only, and read back the same', () => {
  using ctx = setupTest();

  const id = loadOrCreateHostId(ctx.dir);

  expect(id).toMatch(/^[\da-f]{32}$/);
  expect(statSync(join(ctx.dir, 'tailnet-names', 'host-id')).mode & 0o777).toBe(0o600);
  expect(loadOrCreateHostId(ctx.dir)).toBe(id);
});
