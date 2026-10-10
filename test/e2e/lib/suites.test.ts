import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Suite } from './suites';
import {
  FAST_GROUPS,
  HOST_TESTS_GROUP,
  SUITES,
  SUITE_SETS,
  buildJourneyArgv,
  listJourneys,
  readSuitePrefix,
} from './suites';

test('#buildJourneyArgv runs a journey file by a ./ path, which bun test does not read as a name filter', () => {
  expect(buildJourneyArgv('/usr/bin/bun', 'proxy-forwards')).toStrictEqual([
    '/usr/bin/bun',
    'test',
    '--config=test/e2e/bunfig.toml',
    '--bail',
    '--timeout',
    '3600000',
    './test/e2e/suites/proxy-forwards.e2e.ts',
  ]);
});

test('#listJourneys runs the file named for a suite that lists no journeys', () => {
  expect(listJourneys({ name: 'sleep', prefix: 'e2e-slp-', images: [] })).toStrictEqual(['sleep']);
});

test('#listJourneys runs the journeys a suite lists, in their order', () => {
  expect(
    listJourneys({
      name: 'proxy',
      prefix: 'e2e-px-',
      images: [],
      journeys: ['proxy-b', 'proxy-a'],
    }),
  ).toStrictEqual(['proxy-b', 'proxy-a']);
});

test('#readSuitePrefix reads the prefix of a suite', () => {
  expect(readSuitePrefix('templates')).toBe('e2e-tpl-');
});

test('#readSuitePrefix rejects a name that no suite has', () => {
  expect(() => readSuitePrefix('nope')).toThrowWithMessage(Error, 'no suite named nope');
});

test('#SUITES runs every journey file under test/e2e/suites exactly once', () => {
  const suitesDir = join(import.meta.dir, '..', 'suites');

  const files = readdirSync(suitesDir)
    .filter((file) => file.endsWith('.e2e.ts'))
    .map((file) => file.slice(0, -'.e2e.ts'.length));

  const journeys = SUITES.flatMap((suite) => listJourneys(suite));

  expect(journeys).toIncludeSameMembers(files);
  expect(new Set(journeys).size).toBe(journeys.length);
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

test("#SUITES gives no suite a prefix that starts another suite's prefix", () => {
  const prefixes = SUITES.map((suite) => suite.prefix);

  expect(prefixes).toSatisfyAll((prefix: string) =>
    prefixes.every((other) => other === prefix || !other.startsWith(prefix)),
  );
});
