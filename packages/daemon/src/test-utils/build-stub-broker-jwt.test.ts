import { expect, test } from 'bun:test';
import { buildStubBrokerJwt } from './build-stub-broker-jwt';

test('it puts the claims in the second segment as base64url JSON', () => {
  const [, payload] = buildStubBrokerJwt({
    exp: 1_900_000_000,
    email: 'someone@example.com',
  }).split('.');

  expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))).toStrictEqual({
    exp: 1_900_000_000,
    email: 'someone@example.com',
  });
});

test('it builds three segments with an unsigned header', () => {
  const [header, , signature, ...rest] = buildStubBrokerJwt({}).split('.');
  const decoded: unknown = JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'));

  expect(decoded).toStrictEqual({ alg: 'none' });
  expect(signature).toBe('fake');
  expect(rest).toStrictEqual([]);
});

test('it builds the same token for the same claims', () => {
  expect(buildStubBrokerJwt({ sub: 'a' })).toBe(buildStubBrokerJwt({ sub: 'a' }));
});

test('it builds different tokens for different claims', () => {
  expect(buildStubBrokerJwt({ sub: 'a' })).not.toBe(buildStubBrokerJwt({ sub: 'b' }));
});
