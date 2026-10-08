import { expect, test } from 'bun:test';
import { buildMockTokenRecord } from './build-mock-token-record';

test('it builds a default token record', () => {
  const record = buildMockTokenRecord();

  expect(record).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toBeString(),
    secretHash: expect.toBeString(),
    scope: 'manage',
    imps: null,
    grantable: [],
    createdAt: expect.toBeValidDate(),
  });

  expect(record.id).toMatch(/^\w{16}$/);
  expect(record.secretHash).toMatch(/^[0-9a-f]{64}$/);
});

test('it applies overrides on top of the defaults', () => {
  const record = buildMockTokenRecord({
    id: 'abcdefghijklmnop',
    name: 'ci',
    secretHash: 'abcd',
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [{ name: 'gh', generation: 'gen-gh' }],
    createdAt: new Date(1_800_000_000_000),
  });

  expect(record).toStrictEqual({
    id: 'abcdefghijklmnop',
    name: 'ci',
    secretHash: 'abcd',
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [{ name: 'gh', generation: 'gen-gh' }],
    createdAt: new Date(1_800_000_000_000),
  });
});
