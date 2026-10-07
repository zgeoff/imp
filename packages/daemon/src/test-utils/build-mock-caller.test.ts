import { expect, test } from 'bun:test';
import { buildMockCaller } from './build-mock-caller';

test('it builds a default caller', () => {
  const caller = buildMockCaller();

  expect(caller).toStrictEqual({
    kind: 'token',
    name: expect.toBeString(),
    scope: 'manage',
    imps: null,
    grantable: [],
    tokenId: expect.toBeString(),
    grantId: null,
    expiresAt: null,
    principal: `token:${String(caller.tokenId)}`,
    display: caller.name,
  });
});

test('it applies overrides on top of the defaults', () => {
  const caller = buildMockCaller({
    kind: 'tailnet',
    name: 'alice@example.com',
    scope: 'exec',
    imps: ['dev-*'],
    tokenId: null,
  });

  expect(caller).toStrictEqual({
    kind: 'tailnet',
    name: 'alice@example.com',
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [],
    tokenId: null,
    grantId: null,
    expiresAt: null,
    principal: null,
    display: 'alice@example.com',
  });
});
