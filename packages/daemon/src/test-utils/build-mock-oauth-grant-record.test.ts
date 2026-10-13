import { expect, test } from 'bun:test';
import { buildMockOAuthGrantRecord } from './build-mock-oauth-grant-record';

test('it builds a default OAuth grant record', () => {
  const record = buildMockOAuthGrantRecord();

  expect(record).toStrictEqual({
    id: expect.toBeString(),
    clientId: expect.toBeString(),
    tokenId: expect.toBeString(),
    scope: 'manage',
    imps: null,
    resource: expect.toEndWith('/mcp'),
    createdAt: expect.toBeValidDate(),
    lastUsedAt: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  const record = buildMockOAuthGrantRecord({
    id: 'grant-1',
    clientId: 'client-1',
    tokenId: 'token-1',
    scope: 'exec',
    imps: ['dev-*'],
    resource: 'https://impd.test/mcp',
    createdAt: new Date(1_800_000_000_000),
    lastUsedAt: new Date(1_800_000_001_000),
  });

  expect(record).toStrictEqual({
    id: 'grant-1',
    clientId: 'client-1',
    tokenId: 'token-1',
    scope: 'exec',
    imps: ['dev-*'],
    resource: 'https://impd.test/mcp',
    createdAt: new Date(1_800_000_000_000),
    lastUsedAt: new Date(1_800_000_001_000),
  });
});
