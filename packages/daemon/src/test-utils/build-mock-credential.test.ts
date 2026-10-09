import { expect, test } from 'bun:test';
import { buildMockCredential } from './build-mock-credential';

test('it builds a default credential', () => {
  const credential: unknown = buildMockCredential();

  expect(credential).toStrictEqual({
    secretName: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    header: 'authorization',
    value: expect.stringMatching(/^Bearer [A-Za-z0-9]{24}$/) as unknown,
    upstream: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  const credential: unknown = buildMockCredential({
    secretName: 'op',
    upstream: 'http://172.17.0.1:18081',
  });

  expect(credential).toStrictEqual({
    secretName: 'op',
    header: 'authorization',
    value: expect.stringMatching(/^Bearer /) as unknown,
    upstream: 'http://172.17.0.1:18081',
  });
});
