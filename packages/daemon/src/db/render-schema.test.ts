import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSchema } from './render-schema';

// A migration without `bun run render:db-schema` fails here, so CI's
// `bun test` holds schema.ts to the migrations.
test('it matches the committed schema.ts', async () => {
  const committed = readFileSync(join(import.meta.dir, 'schema.ts'), 'utf8');

  const rendered = await renderSchema();

  expect(rendered).toBe(committed);
});

test('it renders the same file twice', async () => {
  const first = await renderSchema();
  const second = await renderSchema();

  expect(second).toBe(first);
});

test('it reads a text primary key as never null', async () => {
  const rendered = await renderSchema();

  expect(rendered).toInclude(
    'export interface OauthTokens {\n  created_at: number;\n  expires_at: number;\n  grant_id: string;\n  id: string;\n',
  );
});
