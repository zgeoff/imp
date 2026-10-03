import { expect, test } from 'bun:test';
import { impContract } from '@imp/api';
import { isContractProcedure } from '@orpc/contract';
import { PROCEDURE_ACCESS, checkAccess, findAccess, isAuditedProcedure } from './access-policy';
import type { Caller } from './caller';
import { buildTestCaller } from './test-callers';

// the secrets that exist, by name, at their generation now
const GENERATIONS = new Map([
  ['gh', 'gen-gh'],
  ['npm', 'gen-npm'],
]);

// the refusal's message, or null when the call is allowed
async function check(path: string, caller: Readonly<Caller>, input: unknown) {
  const refusal = await readRefusal(path, caller, input);

  return refusal?.message ?? null;
}

function readRefusal(path: string, caller: Readonly<Caller>, input: unknown) {
  return checkAccess(findAccess(path), caller, input, (name) =>
    Promise.resolve(GENERATIONS.get(name) ?? null),
  );
}

// a manage token for dev-* that may grant gh as it is now
const GRANTER = buildTestCaller({
  imps: ['dev-*'],
  grantable: [{ name: 'gh', generation: 'gen-gh' }],
});

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

test('a path with no rule is refused to every caller and audited', async () => {
  const refusal = await check('imps.someday', buildTestCaller(), {});

  expect(refusal).toBe('this call has no access rule');
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

test('scopes nest: manage does what exec does, and exec what read does', async () => {
  const refusals = await Promise.all([
    check('imps.stop', buildTestCaller({ scope: 'manage' }), { name: 'a' }),
    check('imps.stop', buildTestCaller({ scope: 'exec' }), { name: 'a' }),
    check('imps.get', buildTestCaller({ scope: 'exec' }), { name: 'a' }),
    check('imps.stop', buildTestCaller({ scope: 'read' }), { name: 'a' }),
  ]);

  expect(refusals).toEqual([null, null, null, 'token test has scope read; this needs exec']);
});

test('a caller with patterns touches only its imps, and never the host', async () => {
  const caller = buildTestCaller({ imps: ['dev-*'] });

  const refusals = await Promise.all([
    check('imps.destroy', caller, { name: 'dev-a' }),
    check('imps.destroy', caller, { name: 'prod' }),

    // a create must name its imp, so impd never picks a name outside them
    check('imps.create', caller, {}),

    // both ends of a fork
    check('imps.fork', caller, { source: 'prod', name: 'dev-copy' }),

    // a list is the handler's to filter
    check('imps.list', caller, {}),
  ]);

  expect(refusals).toEqual([
    null,
    'token test may not touch imp prod',
    'token test is limited to some imps, so the call must name the imp (name)',
    'token test may not touch imp prod',
    null,
  ]);

  const hostWide = await Promise.all(
    ['secrets.add', 'backups.restore', 'tokens.create'].map((path) =>
      check(path, caller, { name: 'dev-a' }),
    ),
  );

  expect(hostWide.every((refusal) => refusal?.includes('host-wide') === true)).toBeTrue();
});

test('a grant needs the imp in the patterns and the secret on the list, each way', async () => {
  const outcomes: string[] = [];

  for (const path of ['grants.add', 'grants.delete']) {
    for (const name of ['dev-a', 'prod']) {
      for (const secret of ['gh', 'npm']) {
        const refusal = await readRefusal(path, GRANTER, { name, secret });

        outcomes.push(`${path} ${name} ${secret} ${refusal?.reason ?? 'allowed'}`);
      }
    }
  }

  expect(outcomes).toEqual([
    'grants.add dev-a gh allowed',
    'grants.add dev-a npm not_grantable',
    'grants.add prod gh imp_out_of_scope',
    'grants.add prod npm imp_out_of_scope',
    'grants.delete dev-a gh allowed',
    'grants.delete dev-a npm not_grantable',
    'grants.delete prod gh imp_out_of_scope',
    'grants.delete prod npm imp_out_of_scope',
  ]);
});

test('a grant is refused without manage, without a list, or for a secret it cannot name', async () => {
  const exec = buildTestCaller({ ...GRANTER, scope: 'exec' });
  const noList = buildTestCaller({ imps: ['dev-*'] });

  const reasons = await Promise.all(
    [
      readRefusal('grants.add', exec, { name: 'dev-a', secret: 'gh' }),
      readRefusal('grants.add', noList, { name: 'dev-a', secret: 'gh' }),
      readRefusal('grants.add', GRANTER, { name: 'dev-a', secret: 'nope' }),
      readRefusal('grants.add', GRANTER, { name: 'dev-a', secret: 'Bad Name!' }),
      readRefusal('grants.add', GRANTER, { name: 'dev-a', secret: 7 }),
      readRefusal('grants.add', GRANTER, { name: 'dev-a' }),
    ].map(async (pending) => {
      const refusal = await pending;

      return refusal?.reason;
    }),
  );

  expect(reasons).toEqual([
    'scope',
    'not_grantable',
    'not_grantable',
    'not_grantable',
    'not_grantable',
    'not_grantable',
  ]);

  // a host-wide manage caller grants any secret
  const hostWide = await check('grants.add', buildTestCaller(), { name: 'prod', secret: 'npm' });

  expect(hostWide).toBeNull();
});

test('a list entry for a secret deleted, or deleted and made again, grants nothing', async () => {
  const stale = buildTestCaller({
    imps: ['dev-*'],
    grantable: [
      { name: 'gh', generation: 'gen-gh-before' },
      { name: 'gone', generation: 'gen-gone' },
    ],
  });

  const refusals = await Promise.all([
    readRefusal('grants.add', stale, { name: 'dev-a', secret: 'gh' }),
    readRefusal('grants.delete', stale, { name: 'dev-a', secret: 'gone' }),
  ]);

  // the same refusal as for a name never on the list: it does not say
  // whether the secret exists
  expect(refusals).toEqual([
    { message: 'token test may not grant or revoke secret gh', reason: 'not_grantable' },
    { message: 'token test may not grant or revoke secret gone', reason: 'not_grantable' },
  ]);
});

test('a token made able to grant may not fork or move, even with every entry stale', async () => {
  const stale = buildTestCaller({
    imps: ['dev-*'],
    grantable: [{ name: 'gone', generation: 'gen-gone' }],
  });

  for (const caller of [GRANTER, stale, { ...GRANTER, kind: 'dashboard' as const }]) {
    const refusals = await Promise.all([
      check('imps.fork', caller, { source: 'dev-a', name: 'dev-b' }),
      check('moves.prepare', caller, { name: 'dev-a' }),
      check('moves.send', caller, { name: 'dev-a' }),
      check('moves.resume', caller, { name: 'dev-a' }),
    ]);

    expect(refusals.every((refusal) => refusal?.includes('may not fork or move') === true)).toBe(
      true,
    );
  }

  // undoing a move and the rest of the imp's calls stay open to it, and
  // the same patterns without a list fork
  const plain = buildTestCaller({ imps: ['dev-*'] });

  const allowed = await Promise.all([
    check('moves.abort', GRANTER, { name: 'dev-a' }),
    check('imps.destroy', GRANTER, { name: 'dev-a' }),
    check('imps.fork', plain, { source: 'dev-a', name: 'dev-b' }),
  ]);

  expect(allowed).toEqual([null, null, null]);
});

// whether a call is refused, and why, leaving out the caller's name
async function readDecision(path: string, caller: Readonly<Caller>, input: unknown) {
  const refusal = await readRefusal(path, caller, input);

  return refusal === null ? 'allowed' : `refused: ${String(refusal.reason)}`;
}

test('an OAuth grant gets the same answer as a token with its scope and imps, on every procedure', async () => {
  const paths = Object.keys(PROCEDURE_ACCESS);
  const inputs: readonly unknown[] = [{ name: 'dev-a' }, { name: 'web' }, {}];
  const differences: string[] = [];

  const cases = (['read', 'exec', 'manage'] as const).flatMap((scope) =>
    [null, ['dev-*']].map((imps) => ({ scope, imps })),
  );

  for (const limits of cases) {
    const token = buildTestCaller(limits);

    const grant = buildTestCaller({
      ...limits,
      kind: 'oauth',
      name: 'conn/grant-a',
      grantId: 'grant-a',
      principal: 'grant:grant-a',
    });

    for (const path of paths) {
      for (const input of inputs) {
        const forToken = await readDecision(path, token, input);
        const forGrant = await readDecision(path, grant, input);

        if (forToken !== forGrant) {
          differences.push(`${path} ${limits.scope}: ${forToken} / ${forGrant}`);
        }
      }
    }
  }

  expect(differences).toEqual([]);
});
