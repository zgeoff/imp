// oxlint-disable zgeoff/test-beside-module -- tests .oxlintrc.json, a config with no module to sit beside
import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as z from 'zod';

// The stage 1 import rules live in .oxlintrc.json's overrides. Each test lints
// one fixture file at a path inside a temp tree laid out like packages/, under a
// config that extends the real one, so the overrides' globs match the fixture.

const DiagnosticSchema = z.object({ code: z.string(), help: z.string().nullish() });
const DiagnosticsSchema = z.object({ diagnostics: z.array(DiagnosticSchema) });

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-import-rules-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // the rules under test: the real config, applied to the temp tree
  writeFileSync(
    join(dir, '.oxlintrc.json'),
    JSON.stringify({ extends: [join(import.meta.dir, '.oxlintrc.json')] }),
  );

  return { dir, oxlint: join(import.meta.dir, 'node_modules/.bin/oxlint') };
}

test('it refuses a kysely import outside the daemon database folder', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'packages/daemon/src/imps/fixture.ts');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "import { Kysely } from 'kysely';\n\nexport const db = Kysely;\n");

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect([...new Set(messages)]).toStrictEqual([
    'Query through a repository in packages/daemon/src/db instead.',
  ]);
});

test.each([
  ['the daemon database folder', 'packages/daemon/src/db/fixture.ts'],
  ['a database test', 'packages/daemon/src/db/fixture.test.ts'],
  ["the daemon's test helpers", 'packages/daemon/src/test-utils/fixture.ts'],
])('it allows a kysely import in %s', (_label, path) => {
  const ctx = setupTest();
  const file = join(ctx.dir, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "import { Kysely } from 'kysely';\n\nexport const db = Kysely;\n");

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect(messages).toStrictEqual([]);
});

test('it refuses a kysely import in a test outside the daemon', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'packages/cli/src/fixture.test.ts');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "import { Kysely } from 'kysely';\n\nexport const db = Kysely;\n");

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect([...new Set(messages)]).toStrictEqual([
    'Query through a repository in packages/daemon/src/db instead.',
  ]);
});

test.each([['shared'], ['api'], ['client']])('it refuses a node: import in packages/%s', (pkg) => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'packages', pkg, 'src/fixture.ts');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "import { join } from 'node:path';\n\nexport const joinPath = join;\n");

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect([...new Set(messages)]).toStrictEqual([
    'Keep this package runtime-neutral: no node: import in @impz/shared, @impz/api or the client.',
  ]);
});

test.each([
  ['a test of a runtime-neutral package', 'packages/api/src/fixture.test.ts'],
  ['a package above the client', 'packages/local-tar/src/fixture.ts'],
])('it allows a node: import in %s', (_label, path) => {
  const ctx = setupTest();
  const file = join(ctx.dir, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "import { join } from 'node:path';\n\nexport const joinPath = join;\n");

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect(messages).toStrictEqual([]);
});

test.each([
  ['packages/daemon/src/imps/fixture.ts', '@impz/test-utils/wait-for'],
  ['packages/daemon/src/imps/fixture.ts', '../test-utils/build-stub-vmm'],
  ['packages/cli/src/fixture.ts', './test-utils/start-cli'],
  ['packages/dashboard/src/fixture.ts', './mocks/db/imp-collection'],
  ['packages/client/src/fixture.ts', '../smoke/run-stub-impd'],

  // the client may import @impz/api, but not the api's test helpers
  ['packages/client/src/fixture.ts', '@impz/api/test-utils/build-mock-image'],
])('it refuses production code in %s that imports %s', (path, source) => {
  const ctx = setupTest();
  const file = join(ctx.dir, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `import { helper } from '${source}';\n\nexport const used = helper;\n`);

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect([...new Set(messages)]).toStrictEqual(['Production code never imports test support.']);
});

test.each([
  ['a test', 'packages/daemon/src/imps/fixture.test.ts'],
  ['a test helper', 'packages/cli/src/test-utils/fixture.ts'],
  ["the dashboard's mock impd", 'packages/dashboard/src/mocks/fixture.ts'],
  ["the client's smoke", 'packages/client/smoke/fixture.ts'],
])('it allows test support in %s', (_label, path) => {
  const ctx = setupTest();
  const file = join(ctx.dir, path);

  mkdirSync(dirname(file), { recursive: true });

  writeFileSync(
    file,
    "import { waitFor } from '@impz/test-utils/wait-for';\n\nexport const wait = waitFor;\n",
  );

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect(messages).toStrictEqual([]);
});

test.each([
  ['shared', '@impz/api', '@impz/shared imports no @impz/* package.'],
  ['local-tar', '@impz/api', '@impz/local-tar is a leaf: it may import only @impz/shared.'],
  ['test-utils', '@impz/api', '@impz/test-utils is a leaf: it may import only @impz/shared.'],
  ['api', '@impz/client', '@impz/api may import only @impz/shared.'],
  ['client', '@impz/mcp', 'The client may import only @impz/shared and @impz/api.'],
  [
    'mcp',
    '@impz/daemon/src/config',
    '@impz/mcp may import only @impz/shared, @impz/local-tar, @impz/api and the client.',
  ],
  [
    'cli',
    '@impz/daemon/src/create-impd',
    '@impz/cli is an app: it may import @impz/shared, @impz/local-tar, @impz/api, the client and @impz/mcp, never another app.',
  ],
  [
    'daemon',
    '@impz/cli',
    '@impz/daemon is an app: it may import @impz/shared, @impz/local-tar, @impz/api, the client and @impz/mcp, never another app.',
  ],
  [
    'dashboard',
    '@impz/daemon/src/auth/authenticate',
    '@impz/dashboard is an app: it may import @impz/shared, @impz/local-tar, @impz/api, the client and @impz/mcp, never another app.',
  ],
])('it refuses packages/%s importing %s', (pkg, source, message) => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'packages', pkg, 'src/fixture.ts');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `import { value } from '${source}';\n\nexport const used = value;\n`);

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect([...new Set(messages)]).toStrictEqual([message]);
});

test.each([
  ['local-tar', '@impz/shared/format-bytes'],
  ['api', '@impz/shared'],
  ['client', '@impz/api'],
  ['mcp', '@impz/local-tar'],
  ['mcp', '@impz/client'],
  ['cli', '@impz/mcp'],
  ['daemon', '@impz/client'],
  ['dashboard', '@impz/api'],
])('it allows packages/%s to import %s', (pkg, source) => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'packages', pkg, 'src/fixture.ts');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `import { value } from '${source}';\n\nexport const used = value;\n`);

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect(messages).toStrictEqual([]);
});

test.each([['cli'], ['test-utils']])(
  'it refuses packages/%s reaching another package by a relative path',
  (pkg) => {
    const ctx = setupTest();
    const file = join(ctx.dir, 'packages', pkg, 'src/fixture.ts');

    mkdirSync(dirname(file), { recursive: true });

    writeFileSync(
      file,
      "import { value } from '../../daemon/src/create-impd';\n\nexport const used = value;\n",
    );

    const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
    const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

    const messages = report.diagnostics
      .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
      .map((diagnostic) => diagnostic.help);

    expect([...new Set(messages)]).toStrictEqual([
      'Import another package by its package name, never by a relative path.',
    ]);
  },
);

test('it counts a type-only import against the package order', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'packages/api/src/fixture.ts');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "import type { Imp } from '@impz/client';\n\nexport type Used = Imp;\n");

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect([...new Set(messages)]).toStrictEqual(['@impz/api may import only @impz/shared.']);
});

test('it counts a type-only re-export against the package order', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'packages/client/src/fixture.ts');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export type { ImpDeps } from '@impz/daemon/src/create-impd';\n");

  const result = Bun.spawnSync([ctx.oxlint, '--format', 'json', file], { cwd: ctx.dir });
  const report = DiagnosticsSchema.parse(JSON.parse(result.stdout.toString()));

  const messages = report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'eslint(no-restricted-imports)')
    .map((diagnostic) => diagnostic.help);

  expect([...new Set(messages)]).toStrictEqual([
    'The client may import only @impz/shared and @impz/api.',
  ]);
});
