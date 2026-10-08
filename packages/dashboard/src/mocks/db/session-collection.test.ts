import { expect, test } from 'bun:test';
import type { Identity } from '@imp/api';
import { sessionCollection } from './session-collection';

test('it creates a default session made with a manage token for every imp', async () => {
  const session: Identity = await sessionCollection.create({});

  expect(session).toStrictEqual({
    kind: 'dashboard',
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    scope: 'manage',
    imps: null,
    grantable: [],
  });
});

test('it applies overrides on top of the defaults', async () => {
  const session: Identity = await sessionCollection.create({ name: 'dev', imps: ['dev-*'] });

  expect(session).toStrictEqual({
    kind: 'dashboard',
    name: 'dev',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: [],
  });
});
