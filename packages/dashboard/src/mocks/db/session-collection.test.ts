import { expect, test } from 'bun:test';
import type { Identity } from '@imp/api';
import { sessionCollection } from './session-collection';

test('it creates a default session made with a manage token for every imp', async () => {
  // impd's sessions last 30 days
  const earliest = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const session: Identity & { readonly expiresAt: Date } = await sessionCollection.create({});

  const latest = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  expect(session).toStrictEqual({
    kind: 'dashboard',
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    scope: 'manage',
    imps: null,
    grantable: [],
    expiresAt: expect.toBeBetween(earliest, latest),
  });
});

test('it applies overrides on top of the defaults', async () => {
  const session: Identity & { readonly expiresAt: Date } = await sessionCollection.create({
    name: 'dev',
    imps: ['dev-*'],
  });

  expect(session).toStrictEqual({
    kind: 'dashboard',
    name: 'dev',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: [],
    expiresAt: expect.toBeValidDate(),
  });
});
