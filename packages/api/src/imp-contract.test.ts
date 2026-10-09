import { expect, test } from 'bun:test';
import { impContract } from './imp-contract';

// An ssh login checks its token once, so no procedure may change a token's
// scope or imps in place; impd's token store holds the same guard
test('it offers no token procedure beyond the known ones', () => {
  expect(Object.keys(impContract.tokens).toSorted()).toStrictEqual([
    'addKey',
    'create',
    'delete',
    'list',
    'removeKey',
    'update',
    'whoami',
  ]);
});

test('it lets a token update change only its grantable list', () => {
  expect(Object.keys(impContract.tokens.update['~orpc'].inputSchema?.shape ?? {})).toStrictEqual([
    'name',
    'grantable',
  ]);
});
