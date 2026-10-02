import { expect, test } from 'bun:test';
import { parsePublicAuth } from './parse-public-auth';

test('no flags is a token, and a user alone means basic', () => {
  expect(parsePublicAuth(undefined, undefined)).toEqual({ auth: 'token' });
  expect(parsePublicAuth('none', undefined)).toEqual({ auth: 'none' });
  expect(parsePublicAuth(undefined, 'ann')).toEqual({ auth: 'basic', user: 'ann' });
  expect(parsePublicAuth('token', undefined)).toEqual({ auth: 'token' });
});

test('an unknown auth, or a user without basic, is a usage error', () => {
  expect(() => parsePublicAuth('oauth', undefined)).toThrow('--auth is none, token or basic');
  expect(() => parsePublicAuth('token', 'ann')).toThrow('--user is for basic auth, not token');
});
