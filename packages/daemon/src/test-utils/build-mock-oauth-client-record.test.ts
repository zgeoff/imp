import { expect, test } from 'bun:test';
import { buildMockOAuthClientRecord } from './build-mock-oauth-client-record';

test('it builds a default OAuth client record', () => {
  const record = buildMockOAuthClientRecord();

  expect(record).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toBeString(),
    redirectUris: [expect.toStartWith('http')],
    createdAt: expect.toBeValidDate(),
  });
});

test('it applies overrides on top of the defaults', () => {
  const record = buildMockOAuthClientRecord({
    id: 'client-1',
    name: 'claude',
    redirectUris: ['https://claude.test/callback'],
    createdAt: new Date(1_800_000_000_000),
  });

  expect(record).toStrictEqual({
    id: 'client-1',
    name: 'claude',
    redirectUris: ['https://claude.test/callback'],
    createdAt: new Date(1_800_000_000_000),
  });
});
