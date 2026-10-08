import { expect, test } from 'bun:test';
import { sessionCollection } from '../mocks/db/session-collection';
import { tokenCollection } from '../mocks/db/token-collection';
import { createDashboardSession } from './create-dashboard-session';

test('it makes a token and a session made with it', async () => {
  const created = await createDashboardSession();

  expect(tokenCollection.findMany().map((token) => token.name)).toStrictEqual([created.token.name]);

  expect(sessionCollection.findMany().map((session) => session.token)).toStrictEqual([
    created.token.name,
  ]);
});

test('it makes the session with the token it is given', async () => {
  const token = await tokenCollection.create({ name: 'dev', imps: ['dev-*'] });
  const created = await createDashboardSession({ token });

  expect(created.session.token).toBe('dev');
  expect(tokenCollection.count()).toBe(1);
});
