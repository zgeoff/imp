import { expect, test } from 'bun:test';
import { isContractProcedure } from '@orpc/contract';
import { impContract } from './imp-contract';
import { IMP_ERRORS } from './imp-errors';

test('it gives every procedure the imp errors', () => {
  const procedures: { procedure: string; missingErrors: string[] }[] = [];
  const pending: [string, unknown][] = Object.entries(impContract);

  // walks the nested routers; the queue grows as each router is opened
  for (const [path, node] of pending) {
    if (isContractProcedure(node)) {
      const errorMap = node['~orpc'].errorMap;

      procedures.push({
        procedure: path,
        missingErrors: Object.keys(IMP_ERRORS).filter((code) => !Object.hasOwn(errorMap, code)),
      });
    } else {
      pending.push(
        ...Object.entries(node as Record<string, unknown>).map(
          ([key, child]): [string, unknown] => [`${path}.${key}`, child],
        ),
      );
    }
  }

  expect(procedures).not.toBeEmpty();
  expect(procedures.filter((entry) => entry.missingErrors.length > 0)).toStrictEqual([]);
});

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
