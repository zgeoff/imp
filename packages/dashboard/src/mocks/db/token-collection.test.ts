import { expect, test } from 'bun:test';
import type { Token } from '@impz/api';
import { readTokenId, tokenCollection } from './token-collection';

test('#tokenCollection creates a default manage token for every imp with its secret', async () => {
  const token: Token & { readonly secret: string } = await tokenCollection.create({});

  expect(token).toStrictEqual({
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    scope: 'manage',
    imps: null,
    sshKeys: [],
    grantable: [],
    imageRefPrefix: null,
    createdAt: expect.toBeValidDate(),
    secret: expect.toSatisfy((value: string) => /^imp_[\w-]{16}\.[\w-]{43}$/u.test(value)),
  });
});

test('#tokenCollection applies overrides on top of the defaults', async () => {
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
    imageRefPrefix: null,
    createdAt: expect.toBeValidDate(),
    secret: expect.toBeString(),
  });
});

test('#readTokenId reads the id out of a secret', () => {
  expect(readTokenId('imp_AbCd-_12.secretpart')).toBe('AbCd-_12');
});
