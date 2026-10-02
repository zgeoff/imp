import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretFiles } from './secret-files';

function setupDir() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-secrets-'));

  return {
    dir,
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('values live in owner-only files in an owner-only directory', () => {
  using tmp = setupDir();

  const files = createSecretFiles(tmp.dir);

  files.write('github', 'ghp_value');

  expect(statSync(join(tmp.dir, 'secrets')).mode & 0o777).toBe(0o700);
  expect(statSync(join(tmp.dir, 'secrets', 'github')).mode & 0o777).toBe(0o600);
  expect(files.read('github')).toBe('ghp_value');

  // a replace leaves no temp file behind
  files.write('github', 'ghp_other');

  expect(readdirSync(join(tmp.dir, 'secrets'))).toEqual(['github']);
  expect(files.read('github')).toBe('ghp_other');

  files.remove('github');

  expect(files.read('github')).toBeNull();
});
