import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderJsonOutputSchema, renderProtocolSchema } from './render-protocol-schema';

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

test('it matches the committed packages/cli/json-output-schema.json', () => {
  const committed = readFileSync(
    join(import.meta.dir, '..', 'packages/cli/json-output-schema.json'),
    'utf8',
  );

  expect(renderJsonOutputSchema()).toBe(committed);
});

test('it renders the same --json output file twice', () => {
  expect(renderJsonOutputSchema()).toBe(renderJsonOutputSchema());
});
