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
      procedures.push({
        procedure: path,
        missingErrors: Object.keys(IMP_ERRORS).filter((code) => !(code in node['~orpc'].errorMap)),
      });
    } else if (typeof node === 'object' && node !== null) {
      pending.push(
        ...Object.entries(node).map(([key, child]): [string, unknown] => [`${path}.${key}`, child]),
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

test('it lets a token update change only its grantable list and its image ref prefix', () => {
  expect(Object.keys(impContract.tokens.update['~orpc'].inputSchema?.shape ?? {})).toStrictEqual([
    'name',
    'grantable',
    'imageRefPrefix',
  ]);
});

test('it refuses a token update that changes nothing', () => {
  const result = impContract.tokens.update['~orpc'].inputSchema?.safeParse({ name: 'ci' });

  expect(result?.error?.issues).toPartiallyContain({
    path: [],
    message: 'must set grantable, imageRefPrefix or both',
  });
});

test('it takes a token update that only clears the image ref prefix', () => {
  const input = { name: 'ci', imageRefPrefix: null };

  expect(impContract.tokens.update['~orpc'].inputSchema?.safeParse(input).data).toStrictEqual(
    input,
  );
});
