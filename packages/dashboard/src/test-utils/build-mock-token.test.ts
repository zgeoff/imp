import { expect, test } from 'bun:test';
import { buildMockToken } from './build-mock-token';

test('it builds a default token', () => {
  expect(buildMockToken()).toStrictEqual({
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    scope: 'read',
    imps: null,
    sshKeys: [],
    grantable: [],
    createdAt: expect.toBeValidDate(),
  });
});

test('it applies overrides on top of the defaults', () => {
  const token = buildMockToken({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  expect(token).toStrictEqual({
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
    sshKeys: [],
    grantable: [],
    createdAt: expect.toBeValidDate(),
  });
});
