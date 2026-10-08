import { expect, test } from 'bun:test';
import { impContract } from '@imp/api';
import { traverseContractProcedures } from '@orpc/server';
import * as z from 'zod';
import { findAccess } from './access-policy';
import { readChangedImps } from './builder-calls';

// A completeness check over the access map. The calls left out name no imp
// that exists (a new one, a backup's, another resource's) or change nothing.
test('it reports the imp of every call that changes an imp it names', () => {
  const notAnImp = new Set([
    'imps.create',
    'moves.receive',
    'backups.restore',
    'leases.list',
    'images.build',
    'images.buildStream',
    'images.delete',
    'secrets.add',
    'secrets.delete',
    'secrets.refresh',
    'networks.create',
    'networks.delete',
    'tokens.create',
    'tokens.update',
    'tokens.delete',
    'tokens.addKey',
    'tokens.removeKey',
    'oauth.clients.add',
    'oauth.clients.update',
    'oauth.clients.delete',
    'system.copyDatabase',
  ]);

  const procedures: { readonly procedure: string; readonly schema: unknown }[] = [];

  traverseContractProcedures({ router: impContract, path: [] }, (found) => {
    procedures.push({
      procedure: found.path.join('.'),
      schema: found.contract['~orpc'].inputSchema,
    });
  });

  const missed = procedures
    .filter((entry) => ['exec', 'manage'].includes(findAccess(entry.procedure)?.scope ?? 'none'))
    .filter((entry) => entry.procedure !== 'imps.destroy' && !notAnImp.has(entry.procedure))
    .filter(
      (entry): entry is { readonly procedure: string; readonly schema: z.ZodObject } =>
        entry.schema instanceof z.ZodObject,
    )
    .flatMap((entry) => {
      const named = Object.keys(entry.schema.shape).filter((key) =>
        ['name', 'imp', 'source'].includes(key),
      );

      const input = Object.fromEntries(named.map((key) => [key, `imp-${key}`]));
      const changed = readChangedImps(entry.procedure, findAccess(entry.procedure), input);

      return named
        .filter((key) => !changed.includes(`imp-${key}`))
        .map((key) => `${entry.procedure} ${key}`);
    });

  expect(missed).toStrictEqual([]);
});

test.each([['imps.get'], ['imps.policy'], ['imps.destroy'], ['sessions.list']])(
  'it reports no imp changed by %s, which a builder may call',
  (procedure) => {
    expect(readChangedImps(procedure, findAccess(procedure), { name: 'b' })).toStrictEqual([]);
  },
);

test('it reports the imp a call on one imp changes', () => {
  expect(
    readChangedImps('imps.setPolicy', findAccess('imps.setPolicy'), { name: 'b' }),
  ).toStrictEqual(['b']);
});

test('it reports the imp a host-wide call changes by its field', () => {
  expect(readChangedImps('images.add', findAccess('images.add'), { imp: 'b' })).toStrictEqual([
    'b',
  ]);
});

test('it reports both imps of a fork', () => {
  expect(
    readChangedImps('imps.fork', findAccess('imps.fork'), { source: 'a', name: 'b' }),
  ).toStrictEqual(['a', 'b']);
});

test('it reports no imp for a call with no access rule', () => {
  expect(readChangedImps('imps.someday', null, { name: 'b' })).toStrictEqual([]);
});

test('it reports no imp for an input that names none', () => {
  expect(readChangedImps('imps.setPolicy', findAccess('imps.setPolicy'), 'b')).toStrictEqual([]);
});
