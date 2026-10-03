import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

// The module's default image is imp-host:<package.json version>. release-please
// tags from its manifest, so the two must name the same release.
const root = path.join(import.meta.dir, '..', '..');

function readJson(name: string): unknown {
  const text = readFileSync(path.join(root, name), 'utf8');

  return JSON.parse(text);
}

test('package.json holds the release that the release-please manifest names', () => {
  const manifest = z.object({ '.': z.string() }).parse(readJson('.release-please-manifest.json'));
  const pkg = z.object({ version: z.string() }).parse(readJson('package.json'));

  expect(manifest['.']).toMatch(/^\d+\.\d+\.\d+/v);
  expect(pkg.version).toBe(manifest['.']);
});
