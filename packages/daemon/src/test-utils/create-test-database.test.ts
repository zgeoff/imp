import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChildTests } from '@imp/test-utils/run-child-tests';
import { createImage, listImages } from '../db/images';
import { listImps } from '../db/imps';
import { createTestDatabase } from './create-test-database';

test('it opens a migrated database that holds no images', async () => {
  const testDatabase = await createTestDatabase();

  expect(listImages(testDatabase.db)).resolves.toStrictEqual([]);
});

test('it opens a migrated database that holds no imps', async () => {
  const testDatabase = await createTestDatabase();

  expect(listImps(testDatabase.db)).resolves.toStrictEqual([]);
});

test('it opens a fresh database on each call', async () => {
  const first = await createTestDatabase();
  const second = await createTestDatabase();

  await createImage(first.db, {
    name: 'dev',
    ref: 'imp/dev:latest',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  const images = await listImages(second.db);

  expect(images).toStrictEqual([]);
});

test('it closes the database on release', async () => {
  const testDatabase = await createTestDatabase();

  await testDatabase[Symbol.asyncDispose]();

  expect(listImages(testDatabase.db)).rejects.toThrow();
});

test('it closes the database when the test finishes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-database-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const run = runChildTests(
    dir,
    [
      "import { expect, test } from 'bun:test';",
      `import { listImages } from ${JSON.stringify(join(import.meta.dir, '../db/images.ts'))};`,
      `import { createTestDatabase } from ${JSON.stringify(join(import.meta.dir, 'create-test-database.ts'))};`,
      'const left: { db: Awaited<ReturnType<typeof createTestDatabase>>["db"] | null } = { db: null };',
      "test('it opens', async () => { left.db = (await createTestDatabase()).db; });",
      "test('it finds it closed', () => { expect(listImages(left.db!)).rejects.toThrow(); });",
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});
