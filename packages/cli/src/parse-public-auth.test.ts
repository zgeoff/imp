import { expect, test } from 'bun:test';
import { parsePublicAuth } from './parse-public-auth';
import { UsageError } from './usage-error';

test('it takes token auth when no flag is given', () => {
  expect(parsePublicAuth(undefined, undefined)).toStrictEqual({ auth: 'token' });
});

test('it takes the auth --auth names', () => {
  expect(parsePublicAuth('none', undefined)).toStrictEqual({ auth: 'none' });
});

test('it takes token auth when --auth names token', () => {
  expect(parsePublicAuth('token', undefined)).toStrictEqual({ auth: 'token' });
});

test('it takes basic auth when only --user is given', () => {
  expect(parsePublicAuth(undefined, 'ann')).toStrictEqual({ auth: 'basic', user: 'ann' });
});

test('it takes basic auth for the user when --auth names basic', () => {
  expect(parsePublicAuth('basic', 'ann')).toStrictEqual({ auth: 'basic', user: 'ann' });
});

test('it rejects an unknown auth as a usage error', () => {
  expect(() => parsePublicAuth('oauth', undefined)).toThrowWithMessage(
    UsageError,
    '--auth is none, token or basic, not oauth',
  );
});

test('it rejects a user for an auth other than basic as a usage error', () => {
  expect(() => parsePublicAuth('token', 'ann')).toThrowWithMessage(
    UsageError,
    '--user is for basic auth, not token',
  );
});
