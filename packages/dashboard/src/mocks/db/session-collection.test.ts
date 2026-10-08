import { expect, test } from 'bun:test';
import { sessionCollection } from './session-collection';

test('it creates a default session of a fresh token that lasts 30 days', async () => {
  const earliest = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const session: { readonly token: string; readonly expiresAt: Date } =
    await sessionCollection.create({});

  const latest = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  expect(session).toStrictEqual({
    token: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    expiresAt: expect.toBeBetween(earliest, latest),
  });
});

test('it applies overrides on top of the defaults', async () => {
  const expiresAt = new Date('2026-10-09T12:00:00Z');

  const session: { readonly token: string; readonly expiresAt: Date } =
    await sessionCollection.create({ token: 'dev', expiresAt });

  expect(session).toStrictEqual({ token: 'dev', expiresAt });
});
