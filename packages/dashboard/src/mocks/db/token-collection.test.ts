import { expect, test } from 'bun:test';
import type { Token } from '@imp/api';
import { tokenCollection } from './token-collection';

test('it creates a default token with its secret', async () => {
  const token: Token & { readonly secret: string } = await tokenCollection.create({});

  expect(token).toStrictEqual({
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    scope: 'read',
    imps: null,
    sshKeys: [],
    grantable: [],
    createdAt: expect.toBeValidDate(),
    secret: expect.toSatisfy((value: string) => /^imp_[a-z0-9]{12}\.[A-Za-z0-9]{43}$/.test(value)),
  });
});

test('it applies overrides on top of the defaults', async () => {
  const token: Token & { readonly secret: string } = await tokenCollection.create({
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
  });

  expect(token).toStrictEqual({
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
    sshKeys: [],
    grantable: [],
    createdAt: expect.toBeValidDate(),
    secret: expect.toBeString(),
  });
});
