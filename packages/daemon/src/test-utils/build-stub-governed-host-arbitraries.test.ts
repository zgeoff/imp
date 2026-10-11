import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { buildStubGovernedHostArbitraries } from './build-stub-governed-host-arbitraries';

test('it generates awake imps with distinct ids', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const samples = fc.sample(arbitraries.awake, { numRuns: 200, seed: 1 });

  expect(samples.map((awake) => awake.map((imp) => imp.id))).toSatisfyAll(
    (ids: readonly string[]) => new Set(ids).size === ids.length,
  );
});

test('it generates awake imps only among the given ids', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const imps = fc.sample(arbitraries.awake, { numRuns: 200, seed: 1 }).flat();

  expect(imps.map((imp) => imp.id)).toSatisfyAll((id: string) => ['a', 'b', 'c'].includes(id));
});

test('it generates awake imps that measure up to 400 MiB', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const imps = fc.sample(arbitraries.awake, { numRuns: 200, seed: 1 }).flat();

  expect(imps.map((imp) => imp.rssMib)).toSatisfyAll((mib: number) => mib >= 0 && mib <= 400);
});

test('it generates some awake imps that fail to sleep and some that do not', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const imps = fc.sample(arbitraries.awake, { numRuns: 200, seed: 1 }).flat();

  expect(new Set(imps.map((imp) => imp.failsSleep))).toStrictEqual(new Set([true, false]));
});

test('it generates admits that reserve 50 to 700 MiB, plus up to 600, for one of the given imps', () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c']);
  const admits = fc.sample(arbitraries.admit, { numRuns: 200, seed: 1 });

  expect(admits.map((admit) => admit.id)).toSatisfyAll((id: string) =>
    ['a', 'b', 'c'].includes(id),
  );

  expect(admits.map((admit) => admit.reserveMib)).toSatisfyAll(
    (mib: number) => mib >= 50 && mib <= 700,
  );

  expect(admits.map((admit) => admit.extraMib)).toSatisfyAll(
    (mib: number) => mib >= 0 && mib <= 600,
  );
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
