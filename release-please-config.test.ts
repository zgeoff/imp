import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { checkReleaseRefs } from './scripts/test-utils/check-release-refs';

// release-please tags from its manifest and rewrites the first X.Y.Z of each marked line in
// its generic extra-files, so every default image, the NixOS module's included, must sit under
// a marker in a listed file and name package.json's version.
test('it keeps a release version in the root package.json', () => {
  const text = readFileSync(new URL('package.json', import.meta.url), 'utf8');
  const pkg = z.object({ version: z.string() }).parse(JSON.parse(text));

  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/v);
});

test('it names in the manifest the release that package.json holds', () => {
  const manifestText = readFileSync(
    new URL('.release-please-manifest.json', import.meta.url),
    'utf8',
  );

  const pkgText = readFileSync(new URL('package.json', import.meta.url), 'utf8');
  const manifest = z.object({ '.': z.string() }).parse(JSON.parse(manifestText));
  const pkg = z.object({ version: z.string() }).parse(JSON.parse(pkgText));

  expect(manifest['.']).toBe(pkg.version);
});

test('it lists every file with a marker as a generic extra-file', () => {
  const configText = readFileSync(new URL('release-please-config.json', import.meta.url), 'utf8');
  const extraFiles = z.array(z.object({ type: z.string(), path: z.string() }));
  const rootPackage = z.object({ 'extra-files': extraFiles });

  const config = z
    .object({ packages: z.object({ '.': rootPackage }) })
    .parse(JSON.parse(configText));

  // the tests and the checker name the markers without being rewritten
  const result = Bun.spawnSync(
    [
      'git',
      'grep',
      '-l',
      'x-release-please-',
      '--',
      ':!*.test.ts',
      ':!scripts/test-utils/check-release-refs.ts',
    ],
    { cwd: new URL('.', import.meta.url).pathname },
  );

  const generic = config.packages['.']['extra-files'].filter((file) => file.type === 'generic');

  expect(result.stdout.toString().trim().split('\n')).toIncludeSameMembers(
    generic.map((file) => file.path),
  );
});

test('it names the release of package.json at every marked default of each generic file, and no other', () => {
  const configText = readFileSync(new URL('release-please-config.json', import.meta.url), 'utf8');
  const pkgText = readFileSync(new URL('package.json', import.meta.url), 'utf8');
  const extraFiles = z.array(z.object({ type: z.string(), path: z.string() }));
  const rootPackage = z.object({ 'extra-files': extraFiles });

  const config = z
    .object({ packages: z.object({ '.': rootPackage }) })
    .parse(JSON.parse(configText));

  const pkg = z.object({ version: z.string() }).parse(JSON.parse(pkgText));
  const generic = config.packages['.']['extra-files'].filter((file) => file.type === 'generic');

  const checked = generic.map((file) => {
    const text = readFileSync(new URL(file.path, import.meta.url), 'utf8');

    return { path: file.path, refs: checkReleaseRefs(file.path, text, pkg.version) };
  });

  expect(checked.flatMap((file) => file.refs.problems)).toStrictEqual([]);

  // a failure names each file that has no marked default
  expect(checked.filter((file) => file.refs.defaults === 0).map((file) => file.path)).toBeEmpty();
});
