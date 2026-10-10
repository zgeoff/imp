import { expect, test } from 'bun:test';
import { buildMockStoredPublicAuth } from './build-mock-stored-public-auth';

test('it builds a default stored public auth', () => {
  expect(buildMockStoredPublicAuth()).toStrictEqual({
    auth: 'basic',
    user: expect.toBeString(),
    hash: expect.toSatisfy((hash: string) => /^[\w\-]{43}$/v.test(hash)),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockStoredPublicAuth({ auth: 'token', user: null })).toStrictEqual({
    auth: 'token',
    user: null,
    hash: expect.toSatisfy((hash: string) => /^[\w\-]{43}$/v.test(hash)),
  });
});
