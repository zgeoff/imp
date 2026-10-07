import { expect, test } from 'bun:test';
import { buildMockIdentity } from './build-mock-identity';

test('it builds a default identity', () => {
  expect(buildMockIdentity()).toStrictEqual({
    kind: 'dashboard',
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    scope: 'manage',
    imps: null,
    grantable: [],
  });
});

test('it applies overrides on top of the defaults', () => {
  const identity = buildMockIdentity({ name: 'dev', imps: ['dev-*'] });

  expect(identity).toStrictEqual({
    kind: 'dashboard',
    name: 'dev',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: [],
  });
});
