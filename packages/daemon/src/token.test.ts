import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateToken } from './token';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-token-'));

  return {
    dir,
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('it creates an owner-only token once and reads the same one back', () => {
  using ctx = setupTest();

  const token = loadOrCreateToken(ctx.dir);

  expect(token).toMatch(/^[\w-]{43}$/);
  expect(statSync(join(ctx.dir, 'token')).mode & 0o777).toBe(0o600);
  expect(loadOrCreateToken(ctx.dir)).toBe(token);
});
