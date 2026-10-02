import { expect, test } from 'bun:test';
import { impContract } from '@imp/api';
import { isContractProcedure } from '@orpc/contract';
import { PROCEDURE_ACCESS, checkAccess, findAccess, isAuditedProcedure } from './access-policy';
import { buildTestCaller } from './test-callers';

// every procedure path in the contract, walked at run time
function listContractPaths(router: unknown, prefix = ''): string[] {
  if (typeof router !== 'object' || router === null) {
    return [];
  }

  const entries: readonly (readonly [string, unknown])[] = Object.entries(router);

  return entries.flatMap(([key, value]) =>
    isContractProcedure(value) ? [`${prefix}${key}`] : listContractPaths(value, `${prefix}${key}.`),
  );
}

test('every procedure in the contract has an access rule, and no rule is stale', () => {
  const paths = listContractPaths(impContract);

  expect(paths.length).toBeGreaterThan(30);
  expect(paths.filter((path) => findAccess(path) === null)).toEqual([]);
  expect(Object.keys(PROCEDURE_ACCESS).toSorted()).toEqual(paths.toSorted());
});

test('a path with no rule is refused to every caller and audited', () => {
  expect(checkAccess(findAccess('imps.someday'), buildTestCaller(), {})).toBe(
    'this call has no access rule',
  );

  expect(isAuditedProcedure('imps.someday')).toBeTrue();
});

test('reads, the event stream and exec tickets are not audited; changes are', () => {
  expect(isAuditedProcedure('imps.list')).toBeFalse();
  expect(isAuditedProcedure('events.stream')).toBeFalse();
  expect(isAuditedProcedure('exec.ticket')).toBeFalse();
  expect(isAuditedProcedure('tokens.whoami')).toBeFalse();
  expect(isAuditedProcedure('imps.sleep')).toBeTrue();
  expect(isAuditedProcedure('tokens.create')).toBeTrue();
});

test('scopes nest: manage does what exec does, and exec what read does', () => {
  const stop = findAccess('imps.stop');
  const get = findAccess('imps.get');

  expect(checkAccess(stop, buildTestCaller({ scope: 'manage' }), { name: 'a' })).toBeNull();
  expect(checkAccess(stop, buildTestCaller({ scope: 'exec' }), { name: 'a' })).toBeNull();
  expect(checkAccess(get, buildTestCaller({ scope: 'exec' }), { name: 'a' })).toBeNull();

  expect(checkAccess(stop, buildTestCaller({ scope: 'read' }), { name: 'a' })).toBe(
    'token test has scope read; this needs exec',
  );
});

test('a caller with patterns touches only its imps, and never the host', () => {
  const caller = buildTestCaller({ imps: ['dev-*'] });

  expect(checkAccess(findAccess('imps.destroy'), caller, { name: 'dev-a' })).toBeNull();

  expect(checkAccess(findAccess('imps.destroy'), caller, { name: 'prod' })).toBe(
    'token test may not touch imp prod',
  );

  // a create must name its imp, so impd never picks a name outside them
  expect(checkAccess(findAccess('imps.create'), caller, {})).toContain('must name the imp');

  // both ends of a fork
  expect(
    checkAccess(findAccess('imps.fork'), caller, { source: 'prod', name: 'dev-copy' }),
  ).toContain('may not touch imp prod');

  for (const path of ['grants.add', 'secrets.add', 'backups.restore', 'tokens.create']) {
    expect(checkAccess(findAccess(path), caller, { name: 'dev-a' })).toContain('host-wide');
  }

  // a list is the handler's to filter
  expect(checkAccess(findAccess('imps.list'), caller, {})).toBeNull();
});
