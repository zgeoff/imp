import { expect, onTestFinished, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretFiles } from './secret-files';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-secrets-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it makes the secrets directory owner-only', async () => {
  const ctx = await setupTest();

  createSecretFiles(ctx.dir);

  expect(statSync(join(ctx.dir, 'secrets')).mode & 0o777).toBe(0o700);
});

test('it makes an existing secrets directory owner-only', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'secrets'), { mode: 0o755 });
  createSecretFiles(ctx.dir);

  expect(statSync(join(ctx.dir, 'secrets')).mode & 0o777).toBe(0o700);
});

test('it writes a value to an owner-only file', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  files.write('github', 'ghp_value');

  expect(statSync(join(ctx.dir, 'secrets', 'github')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(ctx.dir, 'secrets', 'github'), 'utf8')).toBe('ghp_value');
});

test('it replaces a written value and leaves no temp file', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  files.write('github', 'ghp_value');
  files.write('github', 'ghp_other');

  expect(readdirSync(join(ctx.dir, 'secrets'))).toStrictEqual(['github']);
  expect(files.read('github')).toBe('ghp_other');
});

test('it reads a value file', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  writeFileSync(join(ctx.dir, 'secrets', 'github'), 'ghp_value');

  expect(files.read('github')).toBe('ghp_value');
});

test('it reads a missing value file as null', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  expect(files.read('github')).toBeNull();
});

test('it throws when a value file cannot be read for another reason than its absence', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  mkdirSync(join(ctx.dir, 'secrets', 'github'));

  expect(() => files.read('github')).toThrowWithMessage(Error, /EISDIR/);
});

test('it removes a value file', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  files.write('github', 'ghp_value');
  files.remove('github');

  expect(readdirSync(join(ctx.dir, 'secrets'))).toStrictEqual([]);
});

test('it moves the files no row names, temp files included, into a dated directory', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  writeFileSync(join(ctx.dir, 'secrets', 'kept.a1'), 'kept');
  writeFileSync(join(ctx.dir, 'secrets', 'late.b2'), 'late');
  writeFileSync(join(ctx.dir, 'secrets', '.crashed.c3'), 'half');

  const orphans = files.keepOrphansExcept(
    new Set(['kept.a1']),
    new Date('2026-10-04T05:30:00.000Z'),
  );

  expect(orphans).toStrictEqual({
    dir: join(ctx.dir, 'secrets', '.orphaned', '2026-10-04T05-30-00.000Z'),
    files: ['.crashed.c3', 'late.b2'],
  });

  expect(
    readFileSync(
      join(ctx.dir, 'secrets', '.orphaned', '2026-10-04T05-30-00.000Z', 'late.b2'),
      'utf8',
    ),
  ).toBe('late');
});

test('it never moves a file a row names', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  writeFileSync(join(ctx.dir, 'secrets', 'kept.a1'), 'kept');
  writeFileSync(join(ctx.dir, 'secrets', 'late.b2'), 'late');

  files.keepOrphansExcept(new Set(['kept.a1']), new Date('2026-10-04T05:30:00.000Z'));

  expect(readdirSync(join(ctx.dir, 'secrets')).toSorted()).toStrictEqual(['.orphaned', 'kept.a1']);
});

test('it makes the orphans directories owner-only', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  writeFileSync(join(ctx.dir, 'secrets', 'late.b2'), 'late');

  files.keepOrphansExcept(new Set(), new Date('2026-10-04T05:30:00.000Z'));

  expect(statSync(join(ctx.dir, 'secrets', '.orphaned')).mode & 0o777).toBe(0o700);

  expect(
    statSync(join(ctx.dir, 'secrets', '.orphaned', '2026-10-04T05-30-00.000Z')).mode & 0o777,
  ).toBe(0o700);
});

test('it makes no directory when every file has a row', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  writeFileSync(join(ctx.dir, 'secrets', 'kept.a1'), 'kept');

  const orphans = files.keepOrphansExcept(
    new Set(['kept.a1']),
    new Date('2026-10-04T05:30:00.000Z'),
  );

  expect(orphans).toStrictEqual({ dir: null, files: [] });
  expect(readdirSync(join(ctx.dir, 'secrets'))).toStrictEqual(['kept.a1']);
});

test('it makes no new dated directory on a later sweep with nothing orphaned', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  writeFileSync(join(ctx.dir, 'secrets', 'kept.a1'), 'kept');
  writeFileSync(join(ctx.dir, 'secrets', 'late.b2'), 'late');

  files.keepOrphansExcept(new Set(['kept.a1']), new Date('2026-10-04T05:30:00.000Z'));

  const again = files.keepOrphansExcept(new Set(['kept.a1']), new Date('2026-10-05T05:30:00.000Z'));

  expect(again).toStrictEqual({ dir: null, files: [] });

  expect(readdirSync(join(ctx.dir, 'secrets', '.orphaned'))).toStrictEqual([
    '2026-10-04T05-30-00.000Z',
  ]);
});

test('it keeps aside a file where the orphans directory goes', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  writeFileSync(join(ctx.dir, 'secrets', '.orphaned'), 'not a directory');

  const orphans = files.keepOrphansExcept(new Set(), new Date('2026-10-04T05:30:00.000Z'));

  expect(orphans.files).toStrictEqual(['.orphaned.2026-10-04T05-30-00.000Z']);
  expect(lstatSync(join(ctx.dir, 'secrets', '.orphaned')).isDirectory()).toBeTrue();
});

test('it keeps aside a symlink where the orphans directory goes, and never follows it', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  mkdirSync(join(ctx.dir, 'elsewhere'), { mode: 0o755 });
  symlinkSync(join(ctx.dir, 'elsewhere'), join(ctx.dir, 'secrets', '.orphaned'));

  const orphans = files.keepOrphansExcept(new Set(), new Date('2026-10-04T06:00:00.000Z'));

  expect(orphans.files).toStrictEqual(['.orphaned.2026-10-04T06-00-00.000Z']);
  expect(lstatSync(join(ctx.dir, 'secrets', '.orphaned')).isDirectory()).toBeTrue();
  expect(statSync(join(ctx.dir, 'elsewhere')).mode & 0o777).toBe(0o755);
});

test('it throws when the orphans directory cannot be checked', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  // a file where the secrets directory was: every path under it is ENOTDIR
  rmSync(join(ctx.dir, 'secrets'), { recursive: true });
  writeFileSync(join(ctx.dir, 'secrets'), '');

  expect(() =>
    files.keepOrphansExcept(new Set(), new Date('2026-10-04T05:30:00.000Z')),
  ).toThrowWithMessage(Error, /ENOTDIR/);
});

test('it lists no kept directory before any', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  expect(files.listKept()).toStrictEqual([]);
});

test('it lists a kept directory with its files, size and start time', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  mkdirSync(join(ctx.dir, 'secrets', '.orphaned', '2026-10-04T05-30-00.000Z'), { recursive: true });

  writeFileSync(
    join(ctx.dir, 'secrets', '.orphaned', '2026-10-04T05-30-00.000Z', 'late.b2'),
    'late',
  );

  expect(files.listKept()).toStrictEqual([
    {
      name: '2026-10-04T05-30-00.000Z',
      path: join(ctx.dir, 'secrets', '.orphaned', '2026-10-04T05-30-00.000Z'),
      bytes: 4,
      createdAt: new Date('2026-10-04T05:30:00.000Z'),
      files: ['late.b2'],
    },
  ]);
});

test('it lists a kept directory whose name is no time with no start time', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  mkdirSync(join(ctx.dir, 'secrets', '.orphaned', 'by-hand'), { recursive: true });

  expect(files.listKept()).toStrictEqual([
    {
      name: 'by-hand',
      path: join(ctx.dir, 'secrets', '.orphaned', 'by-hand'),
      bytes: 0,
      createdAt: null,
      files: [],
    },
  ]);
});

test('it lists no kept directory for a file in the orphans directory', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  mkdirSync(join(ctx.dir, 'secrets', '.orphaned'));
  writeFileSync(join(ctx.dir, 'secrets', '.orphaned', 'stray'), 'x');

  expect(files.listKept()).toStrictEqual([]);
});

test('it throws when the kept directories cannot be checked', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  // a file where the secrets directory was: every path under it is ENOTDIR
  rmSync(join(ctx.dir, 'secrets'), { recursive: true });
  writeFileSync(join(ctx.dir, 'secrets'), '');

  expect(() => files.listKept()).toThrowWithMessage(Error, /ENOTDIR/);
});

test('it removes a kept directory by name', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  mkdirSync(join(ctx.dir, 'secrets', '.orphaned', '2026-10-04T05-30-00.000Z'), { recursive: true });

  files.removeKept('2026-10-04T05-30-00.000Z');

  expect(readdirSync(join(ctx.dir, 'secrets', '.orphaned'))).toStrictEqual([]);
});

test.each([[''], ['a/b'], ['.'], ['..']])(
  'it refuses to remove %p as a kept directory',
  async (name) => {
    const ctx = await setupTest();

    const files = createSecretFiles(ctx.dir);

    expect(() => {
      files.removeKept(name);
    }).toThrowWithMessage(Error, `not a kept directory: ${name}`);
  },
);

test('it rewrites a file in place by name, owner-only, and leaves no temp file', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  files.write('codex.a1', '{"v":1,"n":"old"}');
  files.rewrite('codex.a1', '{"v":1,"n":"new"}');

  expect(files.read('codex.a1')).toBe('{"v":1,"n":"new"}');
  expect(readdirSync(join(ctx.dir, 'secrets'))).toStrictEqual(['codex.a1']);
  expect(statSync(join(ctx.dir, 'secrets', 'codex.a1')).mode & 0o777).toBe(0o600);
});

test('it throws and leaves no temp file when a rewrite cannot rename into place', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  // a directory where the file goes: the rename fails
  mkdirSync(join(ctx.dir, 'secrets', 'codex.a1'));
  writeFileSync(join(ctx.dir, 'secrets', 'codex.a1', 'keep'), 'x');

  expect(() => {
    files.rewrite('codex.a1', 'new');
  }).toThrowWithMessage(Error, /EISDIR/);

  expect(readdirSync(join(ctx.dir, 'secrets'))).toStrictEqual(['codex.a1']);
  expect(readdirSync(join(ctx.dir, 'secrets', 'codex.a1'))).toStrictEqual(['keep']);
});

test('it rewrites a value of many bytes whole', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dir);

  files.write('codex.a1', 'old');
  files.rewrite('codex.a1', `{"v":1,"n":"${'é'.repeat(300_000)}"}`);

  expect(files.read('codex.a1')).toBe(`{"v":1,"n":"${'é'.repeat(300_000)}"}`);
});
