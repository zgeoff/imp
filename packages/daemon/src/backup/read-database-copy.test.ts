import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupImpTest } from '../imps/test-imps';
import { readDatabaseCopy } from './read-database-copy';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imp-db-copy-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a backup leaves out image builders', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('base');
  await ctx.imps.createImp({ name: 'dev', image: 'base' });
  await ctx.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const copy = await readDatabaseCopy(ctx.db, join(dir, 'copy.sqlite'));

  expect(copy.imps.map((imp) => imp.name)).toEqual(['dev']);
});
