import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderProtocolSchema } from './render-protocol-schema';

// The breaking-change check compares the committed file, so a contract change
// without `bun run render:protocol` fails here.
test('it matches the committed packages/api/protocol-schema.json', () => {
  const committed = readFileSync(
    join(import.meta.dir, '..', 'packages/api/protocol-schema.json'),
    'utf8',
  );

  expect(renderProtocolSchema()).toBe(committed);
});

test('it renders the same file twice', () => {
  expect(renderProtocolSchema()).toBe(renderProtocolSchema());
});
