import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Suite } from './suites';
import { FAST_GROUPS, HOST_TESTS_GROUP, SUITES, SUITE_SETS, buildSuiteArgv } from './suites';

test('#buildSuiteArgv runs a suite file by a ./ path, which bun test does not read as a name filter', () => {
  expect(buildSuiteArgv('/usr/bin/bun', 'sleep')).toStrictEqual([
    '/usr/bin/bun',
    'test',
    '--config=test/e2e/bunfig.toml',
    '--bail',
    '--timeout',
    '3600000',
    './test/e2e/suites/sleep.e2e.ts',
  ]);
});

test('#SUITES gives every suite a file under test/e2e/suites', () => {
  const repoRoot = join(import.meta.dir, '..', '..', '..');

  expect(SUITES).toSatisfyAll((suite: Readonly<Suite>) =>
    existsSync(join(repoRoot, 'test', 'e2e', 'suites', `${suite.name}.e2e.ts`)),
  );
});

test('#SUITES gives every suite its own e2e- imp name prefix', () => {
  const prefixes = SUITES.map((suite) => suite.prefix);

  expect(new Set(prefixes).size).toBe(SUITES.length);
  expect(prefixes).toSatisfyAll((prefix: string) => prefix.startsWith('e2e-'));
});

test('#FAST_GROUPS holds every fast suite and nothing else', () => {
  expect(FAST_GROUPS.flat()).toIncludeSameMembers([...(SUITE_SETS['fast'] ?? [])]);
});

test('#FAST_GROUPS puts no suite in two groups', () => {
  const suites = FAST_GROUPS.flat();

  expect(new Set(suites).size).toBe(suites.length);
});

test('#FAST_GROUPS splits the fast set three ways', () => {
  expect(FAST_GROUPS).toHaveLength(3);
});

test('#FAST_GROUPS keeps the run order inside each group', () => {
  const order = SUITES.map((suite) => suite.name);

  expect(FAST_GROUPS).toSatisfyAll(
    (group: readonly string[]) =>
      order.filter((name) => group.includes(name)).join(',') === group.join(','),
  );
});

test('#FAST_GROUPS leaves scale out, as the fast set does', () => {
  expect(FAST_GROUPS.flat()).not.toContain('scale');
});

test('#HOST_TESTS_GROUP names one of the fast groups', () => {
  expect(HOST_TESTS_GROUP).toBeOneOf([1, 2, 3]);
});

test('#SUITES gives no suite a prefix that a fixture image name starts with', () => {
  const fixtures = ['base', 'e2e-tiny-', 'e2e-bare-', 'e2e-ws-', 'e2e-git-', 'e2e-ra-'];

  expect(SUITES).toSatisfyAll((suite: Readonly<Suite>) =>
    fixtures.every((fixture) => !fixture.startsWith(suite.prefix)),
  );
});
