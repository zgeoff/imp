import { expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

test('files no row names, temp files included, are moved aside into an owner-only directory', () => {
  using tmp = setupDir();

  const files = createSecretFiles(tmp.dir);
  const dir = join(tmp.dir, 'secrets');

  files.write('kept.a1', 'kept');
  files.write('late.b2', 'late');

  writeFileSync(join(dir, '.crashed.c3'), 'half');

  const at = new Date('2026-10-04T05:30:00.000Z');

  const orphans = files.keepOrphansExcept(new Set(['kept.a1']), at);
  const target = join(dir, '.orphaned', '2026-10-04T05-30-00.000Z');

  expect(orphans).toEqual({ dir: target, files: ['.crashed.c3', 'late.b2'] });
  expect(readdirSync(dir).toSorted()).toEqual(['.orphaned', 'kept.a1']);
  expect(readFileSync(join(target, 'late.b2'), 'utf8')).toBe('late');
  expect(statSync(join(dir, '.orphaned')).mode & 0o777).toBe(0o700);
  expect(statSync(target).mode & 0o777).toBe(0o700);

  // nothing more to set aside: no new directory
  const again = files.keepOrphansExcept(new Set(['kept.a1']), new Date());

  expect(again).toEqual({ dir: null, files: [] });
  expect(readdirSync(join(dir, '.orphaned'))).toHaveLength(1);
});

test('a file or a symlink where the orphans directory goes is kept aside, not followed', () => {
  using tmp = setupDir();

  const files = createSecretFiles(tmp.dir);
  const dir = join(tmp.dir, 'secrets');
  const elsewhere = join(tmp.dir, 'elsewhere');

  mkdirSync(elsewhere, { mode: 0o755 });
  writeFileSync(join(dir, '.orphaned'), 'not a directory');

  const at = new Date('2026-10-04T05:30:00.000Z');

  const orphans = files.keepOrphansExcept(new Set(), at);

  expect(orphans.files).toEqual(['.orphaned.2026-10-04T05-30-00.000Z']);
  expect(statSync(join(dir, '.orphaned')).isDirectory()).toBe(true);

  // a symlink goes the same way, and the chmod never reaches its target
  rmSync(join(dir, '.orphaned'), { recursive: true });
  symlinkSync(elsewhere, join(dir, '.orphaned'));

  const later = files.keepOrphansExcept(new Set(), new Date('2026-10-04T06:00:00.000Z'));

  expect(later.files).toEqual(['.orphaned.2026-10-04T06-00-00.000Z']);
  expect(lstatSync(join(dir, '.orphaned')).isDirectory()).toBe(true);
  expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
});

test('the kept directories are listed with their files, and removed by name only', () => {
  using tmp = setupDir();

  const files = createSecretFiles(tmp.dir);

  expect(files.listKept()).toEqual([]);

  files.write('late.b2', 'late');

  const at = new Date('2026-10-04T05:30:00.000Z');

  const orphans = files.keepOrphansExcept(new Set(), at);

  expect(files.listKept()).toEqual([
    {
      name: '2026-10-04T05-30-00.000Z',
      path: orphans.dir ?? '',
      bytes: 4,
      createdAt: at,
      files: ['late.b2'],
    },
  ]);

  expect(() => {
    files.removeKept('..');
  }).toThrow('not a kept directory');

  files.removeKept('2026-10-04T05-30-00.000Z');

  expect(files.listKept()).toEqual([]);
});
