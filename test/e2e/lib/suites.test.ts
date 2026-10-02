import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SUITES, buildSuiteArgv } from './suites';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

test('it runs a suite file by a ./ path, which bun test does not read as a name filter', () => {
  const argv = buildSuiteArgv('/usr/bin/bun', 'sleep');

  expect(argv.slice(0, 3)).toEqual(['/usr/bin/bun', 'test', '--bail']);
  expect(argv.at(-1)).toBe('./test/e2e/suites/sleep.e2e.ts');
});

test('every suite has a file and its own imp name prefix', () => {
  const prefixes = new Set(SUITES.map((suite) => suite.prefix));

  expect(prefixes.size).toBe(SUITES.length);

  for (const suite of SUITES) {
    const path = buildSuiteArgv('bun', suite.name).at(-1) ?? '';

    expect(existsSync(join(REPO_ROOT, path))).toBeTrue();
    expect(suite.prefix).toStartWith('e2e-');
  }
});
