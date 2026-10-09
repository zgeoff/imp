import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { buildStubGovernedHostArbitraries } from './build-stub-governed-host-arbitraries';

test('it generates awake imps with distinct ids', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const samples = fc.sample(arbitraries.awake, { numRuns: 200, seed: 1 });

  expect(
    samples.filter((awake) => new Set(awake.map((imp) => imp.id)).size !== awake.length),
  ).toStrictEqual([]);
});

test('it generates awake imps only among the given ids', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const imps = fc.sample(arbitraries.awake, { numRuns: 200, seed: 1 }).flat();

  expect(imps.filter((imp) => !['a', 'b', 'c'].includes(imp.id))).toStrictEqual([]);
});

test('it generates awake imps that measure up to 400 MiB', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const imps = fc.sample(arbitraries.awake, { numRuns: 200, seed: 1 }).flat();

  expect(imps.filter((imp) => imp.rssMib < 0 || imp.rssMib > 400)).toStrictEqual([]);
});

test('it generates some awake imps that fail to sleep and some that do not', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const imps = fc.sample(arbitraries.awake, { numRuns: 200, seed: 1 }).flat();

  expect(new Set(imps.map((imp) => imp.failsSleep))).toStrictEqual(new Set([true, false]));
});

test('it generates admits that reserve 50 to 700 MiB, plus up to 600, for one of the given imps', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const admits = fc.sample(arbitraries.admit, { numRuns: 200, seed: 1 });

  expect(
    admits.filter(
      (admit) =>
        !['a', 'b', 'c'].includes(admit.id) ||
        admit.reserveMib < 50 ||
        admit.reserveMib > 700 ||
        admit.extraMib < 0 ||
        admit.extraMib > 600,
    ),
  ).toStrictEqual([]);
});

test('it generates every kind of host change', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);

  const kinds = new Set(
    fc.sample(arbitraries.change, { numRuns: 500, seed: 1 }).map((change) => change.kind),
  );

  expect([...kinds].toSorted()).toStrictEqual([
    'busy',
    'failSleep',
    'hold',
    'rss',
    'spare',
    'stop',
    'tick',
    'touch',
  ]);
});
