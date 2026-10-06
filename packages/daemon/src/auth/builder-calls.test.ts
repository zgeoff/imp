import { expect, test } from 'bun:test';
import { impContract } from '@imp/api';
import * as z from 'zod';
import { PROCEDURE_ACCESS, findAccess } from './access-policy';
import { readChangedImps } from './builder-calls';

// the calls whose `name` is no imp that exists: a new one, a backup's, or
// another resource's; and leases.list, which changes nothing
const NOT_AN_IMP_CALLS = new Set([
  'imps.create',
  'moves.receive',
  'backups.restore',
  'leases.list',
  'images.build',
  'images.buildStream',
  'images.delete',
  'secrets.add',
  'secrets.delete',
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

const IMP_FIELDS = new Set(['name', 'imp', 'source']);

// a zod schema without its optional wrapper
function readUnwrapped(schema: unknown): unknown {
  return schema instanceof z.ZodOptional ? schema.unwrap() : schema;
}

// the input fields of a procedure that hold a string, from its contract
function readStringFields(procedure: string): string[] {
  const contract = procedure
    .split('.')
    .reduce<unknown>(
      (node, key) => (typeof node === 'object' && node !== null ? Reflect.get(node, key) : null),
      impContract,
    );

  const orpc: unknown =
    typeof contract === 'object' && contract !== null ? Reflect.get(contract, '~orpc') : null;

  const schema: unknown =
    typeof orpc === 'object' && orpc !== null ? Reflect.get(orpc, 'inputSchema') : null;

  const object = readUnwrapped(schema);

  if (!(object instanceof z.ZodObject)) {
    return [];
  }

  return Object.entries<unknown>(object.shape).flatMap(([key, field]) =>
    readUnwrapped(field) instanceof z.ZodString ? [key] : [],
  );
}

test('every call that changes an imp it names is one a builder refuses', () => {
  const missed = Object.keys(PROCEDURE_ACCESS).flatMap((procedure) => {
    const access = findAccess(procedure);

    if (access === null || access.scope === 'read' || procedure === 'imps.destroy') {
      return [];
    }

    if (NOT_AN_IMP_CALLS.has(procedure)) {
      return [];
    }

    const named = readStringFields(procedure).filter((field) => IMP_FIELDS.has(field));
    const input = Object.fromEntries(named.map((field) => [field, `imp-${field}`]));
    const changed = readChangedImps(procedure, access, input);

    return named
      .filter((field) => !changed.includes(`imp-${field}`))
      .map((field) => `${procedure} ${field}`);
  });

  expect(missed).toEqual([]);
});

test('a read and rm reach a builder', () => {
  for (const procedure of ['imps.get', 'imps.policy', 'imps.destroy', 'sessions.list']) {
    expect(readChangedImps(procedure, findAccess(procedure), { name: 'b' })).toEqual([]);
  }

  expect(readChangedImps('imps.setPolicy', findAccess('imps.setPolicy'), { name: 'b' })).toEqual([
    'b',
  ]);
});
