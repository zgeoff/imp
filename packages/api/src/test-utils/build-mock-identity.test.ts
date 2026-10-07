import { expect, test } from 'bun:test';
import { IdentitySchema } from '../token-schema';
import { buildMockIdentity } from './build-mock-identity';

test('it builds a default identity', () => {
  const identity = buildMockIdentity();
  const parsed: unknown = IdentitySchema.safeParse(identity).data;
  const received: unknown = identity;

  expect(received).toStrictEqual({
    kind: 'token',
    name: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    scope: 'manage',
    imps: null,
    grantable: [],
  });

  expect(parsed).toStrictEqual(identity);
});

test('it applies overrides on top of the defaults', () => {
  const identity: unknown = buildMockIdentity({ scope: 'read', imps: ['ci-*'] });

  expect(identity).toStrictEqual({
    kind: 'token',
    name: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    scope: 'read',
    imps: ['ci-*'],
    grantable: [],
  });
});
