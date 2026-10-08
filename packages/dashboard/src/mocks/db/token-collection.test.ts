import { expect, test } from 'bun:test';
import type { Token } from '@imp/api';
import { tokenCollection } from './token-collection';

test('it creates a default manage token for every imp with its secret', async () => {
  const token: Token & { readonly secret: string } = await tokenCollection.create({});

  expect(token).toStrictEqual({
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    scope: 'manage',
    imps: null,
    sshKeys: [],
    grantable: [],
    createdAt: expect.toBeValidDate(),
    secret: expect.toSatisfy((value: string) => /^imp_[\w-]{16}\.[\w-]{43}$/.test(value)),
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
