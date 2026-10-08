import { expect, test } from 'bun:test';
import { TokenSchema } from '../token-schema';
import { buildMockToken } from './build-mock-token';

test('it builds a default token', () => {
  const token = buildMockToken();
  const parsed: unknown = TokenSchema.safeParse(token).data;
  const received: unknown = token;

  expect(received).toStrictEqual({
    name: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    scope: 'manage',
    imps: null,
    sshKeys: [],
    grantable: [],
    createdAt: expect.toBeValidDate() as unknown,
  });

  expect(parsed).toStrictEqual(token);
});

test('it applies overrides on top of the defaults', () => {
  const token: unknown = buildMockToken({ name: 'ci', scope: 'exec', imps: ['ci-*'] });

  expect(token).toStrictEqual({
    name: 'ci',
    scope: 'exec',
    imps: ['ci-*'],
    sshKeys: [],
    grantable: [],
    createdAt: expect.toBeValidDate() as unknown,
  });
});
