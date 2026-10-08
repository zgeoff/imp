import { expect, test } from 'bun:test';
import { impContract } from '@imp/api';
import { traverseContractProcedures } from '@orpc/server';
import { buildMockCaller } from '../test-utils/build-mock-caller';
import {
  PROCEDURE_ACCESS,
  checkAccess,
  findAccess,
  findForkAuthority,
  findGrantAuthority,
  isAuditedProcedure,
  isRefusalAudited,
  readField,
} from './access-policy';

test('#PROCEDURE_ACCESS has a rule for every procedure in the contract, and no stale rule', () => {
  const paths: string[] = [];

  traverseContractProcedures({ router: impContract, path: [] }, (procedure) => {
    paths.push(procedure.path.join('.'));
  });

  expect(Object.keys(PROCEDURE_ACCESS)).toIncludeSameMembers(paths);
});

test('#checkAccess refuses a path with no rule to every caller', async () => {
  const refusal = await checkAccess(findAccess('imps.someday'), buildMockCaller(), {}, () =>
    Promise.resolve(null),
  );

  expect(refusal).toStrictEqual({ message: 'this call has no access rule', reason: null });
});

test.each([
  ['imps.someday', true],
  ['imps.sleep', true],
  ['tokens.create', true],
  ['images.addStream', false],
  ['imps.list', false],
  ['events.stream', false],
  ['exec.ticket', false],
  ['leases.list', false],
  ['tokens.whoami', false],
])('#isAuditedProcedure answers %s with %p', (procedure, audited) => {
  expect(isAuditedProcedure(procedure)).toBe(audited);
});

test.each([
  ['images.addStream', true],
  ['images.buildStream', true],
  ['imps.sleep', false],
  ['imps.someday', false],
])('#isRefusalAudited answers %s with %p', (procedure, audited) => {
  expect(isRefusalAudited(procedure)).toBe(audited);
});

test.each([
  ['imps.stop', 'manage'],
  ['imps.stop', 'exec'],
  ['imps.get', 'exec'],
  ['imps.get', 'read'],
] as const)('#checkAccess lets %s through for a caller with scope %s', async (path, scope) => {
  const refusal = await checkAccess(
    findAccess(path),
    buildMockCaller({ scope }),
    { name: 'a' },
    () => Promise.resolve(null),
  );

  expect(refusal).toBeNull();
});

test('#checkAccess refuses a call that needs a scope above the caller’s', async () => {
  const caller = buildMockCaller({ scope: 'read' });

  const refusal = await checkAccess(findAccess('imps.stop'), caller, { name: 'a' }, () =>
    Promise.resolve(null),
  );

  expect(refusal).toStrictEqual({
    message: `token ${caller.name} has scope read; this needs exec`,
    reason: 'scope',
  });
});

test('#checkAccess lets a caller with patterns touch an imp within them', async () => {
  const refusal = await checkAccess(
    findAccess('imps.destroy'),
    buildMockCaller({ imps: ['dev-*'] }),
    { name: 'dev-a' },
    () => Promise.resolve(null),
  );

  expect(refusal).toBeNull();
});

test('#checkAccess refuses a caller with patterns an imp outside them', async () => {
  const caller = buildMockCaller({ imps: ['dev-*'] });

  const refusal = await checkAccess(findAccess('imps.destroy'), caller, { name: 'prod' }, () =>
    Promise.resolve(null),
  );

  expect(refusal).toStrictEqual({
    message: `token ${caller.name} may not touch imp prod`,
    reason: 'imp_out_of_scope',
  });
});

test('#checkAccess makes a caller with patterns name the imp it creates', async () => {
  const caller = buildMockCaller({ imps: ['dev-*'] });

  const refusal = await checkAccess(findAccess('imps.create'), caller, {}, () =>
    Promise.resolve(null),
  );

  expect(refusal).toStrictEqual({
    message: `token ${caller.name} is limited to some imps, so the call must name the imp (name)`,
    reason: 'imp_out_of_scope',
  });
});

test('#checkAccess refuses a fork whose source is outside the caller’s patterns', async () => {
  const caller = buildMockCaller({ imps: ['dev-*'] });

  const refusal = await checkAccess(
    findAccess('imps.fork'),
    caller,
    { source: 'prod', name: 'dev-copy' },
    () => Promise.resolve(null),
  );

  expect(refusal).toStrictEqual({
    message: `token ${caller.name} may not touch imp prod`,
    reason: 'imp_out_of_scope',
  });
});

test('#checkAccess leaves a list to its handler for a caller with patterns', async () => {
  const refusal = await checkAccess(
    findAccess('imps.list'),
    buildMockCaller({ imps: ['dev-*'] }),
    {},
    () => Promise.resolve(null),
  );

  expect(refusal).toBeNull();
});

test.each([['secrets.add'], ['secrets.refresh'], ['backups.restore'], ['tokens.create']])(
  '#checkAccess refuses the host-wide call %s to a caller with patterns',
  async (path) => {
    const caller = buildMockCaller({ imps: ['dev-*'] });

    const refusal = await checkAccess(findAccess(path), caller, { name: 'dev-a' }, () =>
      Promise.resolve(null),
    );

    expect(refusal).toStrictEqual({
      message: `token ${caller.name} is limited to some imps; this call is host-wide`,
      reason: null,
    });
  },
);

test.each([
  ['grants.add', 'dev-a', 'gh'],
  ['grants.delete', 'dev-a', 'gh'],
])(
  '#checkAccess lets %s of imp %s and secret %s through, for a token that may grant gh to dev-*',
  async (path, name, secret) => {
    const refusal = await checkAccess(
      findAccess(path),
      buildMockCaller({ imps: ['dev-*'], grantable: [{ name: 'gh', generation: 'gen-gh' }] }),
      { name, secret },
      (each) =>
        Promise.resolve(
          new Map([
            ['gh', 'gen-gh'],
            ['npm', 'gen-npm'],
          ]).get(each) ?? null,
        ),
    );

    expect(refusal).toBeNull();
  },
);

test.each([
  ['grants.add', 'dev-a', 'npm', 'not_grantable'],
  ['grants.add', 'prod', 'gh', 'imp_out_of_scope'],
  ['grants.add', 'prod', 'npm', 'imp_out_of_scope'],
  ['grants.delete', 'dev-a', 'npm', 'not_grantable'],
  ['grants.delete', 'prod', 'gh', 'imp_out_of_scope'],
  ['grants.delete', 'prod', 'npm', 'imp_out_of_scope'],
] as const)(
  '#checkAccess refuses %s of imp %s and secret %s, for a token that may grant gh to dev-*, as %s',
  async (path, name, secret, reason) => {
    const refusal = await checkAccess(
      findAccess(path),
      buildMockCaller({ imps: ['dev-*'], grantable: [{ name: 'gh', generation: 'gen-gh' }] }),
      { name, secret },
      (each) =>
        Promise.resolve(
          new Map([
            ['gh', 'gen-gh'],
            ['npm', 'gen-npm'],
          ]).get(each) ?? null,
        ),
    );

    expect(refusal?.reason).toBe(reason);
  },
);

test('#checkAccess refuses a grant to a token below manage, for its scope', async () => {
  const caller = buildMockCaller({
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [{ name: 'gh', generation: 'gen-gh' }],
  });

  const refusal = await checkAccess(
    findAccess('grants.add'),
    caller,
    { name: 'dev-a', secret: 'gh' },
    () => Promise.resolve('gen-gh'),
  );

  expect(refusal?.reason).toBe('scope');
});

test('#checkAccess refuses a grant to a token with patterns and no list', async () => {
  const caller = buildMockCaller({ imps: ['dev-*'] });

  const refusal = await checkAccess(
    findAccess('grants.add'),
    caller,
    { name: 'dev-a', secret: 'gh' },
    () => Promise.resolve('gen-gh'),
  );

  expect(refusal).toStrictEqual({
    message: `token ${caller.name} may not grant or revoke secret gh`,
    reason: 'not_grantable',
  });
});

test.each([
  [{ name: 'dev-a', secret: 'Bad Name!' }, 'a name that is no secret name'],
  [{ name: 'dev-a', secret: 7 }, 'a secret that is not a string'],
  [{ name: 'dev-a' }, 'no secret'],
])('#checkAccess refuses a grant of %p, %s, without naming it', async (input) => {
  const caller = buildMockCaller({
    imps: ['dev-*'],
    grantable: [{ name: 'gh', generation: 'gen-gh' }],
  });

  const refusal = await checkAccess(findAccess('grants.add'), caller, input, () =>
    Promise.resolve('gen-gh'),
  );

  expect(refusal).toStrictEqual({
    message: `token ${caller.name} may not grant or revoke that secret`,
    reason: 'not_grantable',
  });
});

test('#checkAccess lets a host-wide manage caller grant any secret', async () => {
  const refusal = await checkAccess(
    findAccess('grants.add'),
    buildMockCaller(),
    { name: 'prod', secret: 'npm' },
    () => Promise.resolve('gen-npm'),
  );

  expect(refusal).toBeNull();
});

test('#checkAccess refuses a list entry for a secret deleted and made again, as for one never listed', async () => {
  const caller = buildMockCaller({
    imps: ['dev-*'],
    grantable: [{ name: 'gh', generation: 'gen-gh-before' }],
  });

  const refusal = await checkAccess(
    findAccess('grants.add'),
    caller,
    { name: 'dev-a', secret: 'gh' },
    () => Promise.resolve('gen-gh'),
  );

  expect(refusal).toStrictEqual({
    message: `token ${caller.name} may not grant or revoke secret gh`,
    reason: 'not_grantable',
  });
});

test('#checkAccess refuses a list entry for a deleted secret, as for one never listed', async () => {
  const caller = buildMockCaller({
    imps: ['dev-*'],
    grantable: [{ name: 'gone', generation: 'gen-gone' }],
  });

  const refusal = await checkAccess(
    findAccess('grants.delete'),
    caller,
    { name: 'dev-a', secret: 'gone' },
    () => Promise.resolve(null),
  );

  expect(refusal).toStrictEqual({
    message: `token ${caller.name} may not grant or revoke secret gone`,
    reason: 'not_grantable',
  });
});

test.each([
  ['imps.fork', 'token', 'gen-gh'],
  ['moves.prepare', 'token', 'gen-gh'],
  ['moves.send', 'token', 'gen-gh'],
  ['moves.resume', 'token', 'gen-gh'],
  ['imps.fork', 'dashboard', 'gen-gh'],
  ['moves.prepare', 'dashboard', 'gen-gh'],
  ['moves.send', 'dashboard', 'gen-gh'],
  ['moves.resume', 'dashboard', 'gen-gh'],
  ['imps.fork', 'token', 'gen-gh-stale'],
  ['moves.prepare', 'token', 'gen-gh-stale'],
] as const)(
  '#checkAccess refuses %s to a %s caller made able to grant, with its entry at %s',
  async (path, kind, generation) => {
    const caller = buildMockCaller({
      kind,
      imps: ['dev-*'],
      grantable: [{ name: 'gh', generation }],
    });

    const refusal = await checkAccess(
      findAccess(path),
      caller,
      { source: 'dev-a', name: 'dev-b' },
      () => Promise.resolve('gen-gh'),
    );

    expect(refusal).toStrictEqual({
      message: `${kind} ${caller.name} may grant secrets, so it may not fork or move an imp`,
      reason: null,
    });
  },
);

test.each([['moves.abort'], ['imps.destroy']])(
  '#checkAccess lets a caller made able to grant make %s',
  async (path) => {
    const refusal = await checkAccess(
      findAccess(path),
      buildMockCaller({ imps: ['dev-*'], grantable: [{ name: 'gh', generation: 'gen-gh' }] }),
      { name: 'dev-a' },
      () => Promise.resolve('gen-gh'),
    );

    expect(refusal).toBeNull();
  },
);

test('#checkAccess lets a caller with the same patterns and no list fork', async () => {
  const refusal = await checkAccess(
    findAccess('imps.fork'),
    buildMockCaller({ imps: ['dev-*'] }),
    { source: 'dev-a', name: 'dev-b' },
    () => Promise.resolve(null),
  );

  expect(refusal).toBeNull();
});

test.each([
  ['grants.add', 'read', null, [], 'oauth laptop has scope read; this needs manage', 'scope'],
  ['grants.delete', 'read', null, [], 'oauth laptop has scope read; this needs manage', 'scope'],
  ['grants.add', 'read', ['dev-*'], [], 'oauth laptop has scope read; this needs manage', 'scope'],
  [
    'grants.delete',
    'read',
    ['dev-*'],
    [],
    'oauth laptop has scope read; this needs manage',
    'scope',
  ],
  ['grants.add', 'exec', null, [], 'oauth laptop has scope exec; this needs manage', 'scope'],
  ['grants.delete', 'exec', null, [], 'oauth laptop has scope exec; this needs manage', 'scope'],
  ['grants.add', 'exec', ['dev-*'], [], 'oauth laptop has scope exec; this needs manage', 'scope'],
  [
    'grants.delete',
    'exec',
    ['dev-*'],
    [],
    'oauth laptop has scope exec; this needs manage',
    'scope',
  ],
  ['grants.add', 'manage', null, [], 'oauth laptop may not grant or revoke secrets', null],
  ['grants.delete', 'manage', null, [], 'oauth laptop may not grant or revoke secrets', null],
  ['grants.add', 'manage', ['dev-*'], [], 'oauth laptop may not grant or revoke secrets', null],
  ['grants.delete', 'manage', ['dev-*'], [], 'oauth laptop may not grant or revoke secrets', null],
  [
    'grants.add',
    'manage',
    ['dev-*'],
    [{ name: 'gh', generation: 'gen-gh' }],
    'oauth laptop may not grant or revoke secrets',
    null,
  ],
  [
    'grants.delete',
    'manage',
    ['dev-*'],
    [{ name: 'gh', generation: 'gen-gh' }],
    'oauth laptop may not grant or revoke secrets',
    null,
  ],
] as const)(
  '#checkAccess refuses an OAuth grant %s of a secret, with scope %s, patterns %p and list %p',
  async (path, scope, imps, grantable, message, reason) => {
    const caller = buildMockCaller({
      kind: 'oauth',
      name: 'laptop',
      scope,
      imps,
      grantable,
      grantId: 'grant-a',
      principal: 'grant:grant-a',
    });

    const refusal = await checkAccess(
      findAccess(path),
      caller,
      { name: 'dev-a', secret: 'gh' },
      () => Promise.resolve('gen-gh'),
    );

    expect(refusal).toStrictEqual({ message, reason });
  },
);

test.each([['imps.fork'], ['moves.prepare'], ['moves.send'], ['moves.resume']])(
  '#checkAccess refuses %s to a caller whose only list entry names a deleted secret',
  async (path) => {
    const caller = buildMockCaller({
      imps: ['dev-*'],
      grantable: [{ name: 'gone', generation: 'gen-gone' }],
    });

    const refusal = await checkAccess(
      findAccess(path),
      caller,
      { source: 'dev-a', name: 'dev-b' },
      () => Promise.resolve(null),
    );

    expect(refusal).toStrictEqual({
      message: `token ${caller.name} may grant secrets, so it may not fork or move an imp`,
      reason: null,
    });
  },
);

// A conformance check over every procedure, but the grants of secrets: an
// OAuth grant gets the answer its token would, for each scope and patterns
test.each([
  ['read', null, []],
  ['read', ['dev-*'], []],
  ['exec', null, []],
  ['exec', ['dev-*'], []],
  ['manage', null, []],
  ['manage', ['dev-*'], []],
  ['manage', ['dev-*'], [{ name: 'gh', generation: 'gen-gh' }]],
] as const)(
  '#checkAccess gives an OAuth grant its %s token’s answer, for patterns %p and list %p',
  async (scope, imps, grantable) => {
    const token = buildMockCaller({ name: 'laptop', scope, imps, grantable });

    const grant = buildMockCaller({
      kind: 'oauth',
      name: 'laptop',
      scope,
      imps,
      grantable,
      grantId: 'grant-a',
      principal: 'grant:grant-a',
    });

    const paths = Object.keys(PROCEDURE_ACCESS).filter((path) => findAccess(path)?.on !== 'grant');
    const inputs = [{ name: 'dev-a', secret: 'gh' }, { name: 'web' }, {}];

    const generations = new Map([['gh', 'gen-gh']]);

    const readGeneration = (name: string) => Promise.resolve(generations.get(name) ?? null);

    const answers = await Promise.all(
      paths.flatMap((path) =>
        inputs.map(async (input) => {
          const forToken = await checkAccess(findAccess(path), token, input, readGeneration);
          const forGrant = await checkAccess(findAccess(path), grant, input, readGeneration);

          return {
            path,
            token: forToken?.reason ?? forToken?.message.replace('token ', '') ?? null,
            grant: forGrant?.reason ?? forGrant?.message.replace('oauth ', '') ?? null,
          };
        }),
      ),
    );

    expect(answers.filter((answer) => answer.token !== answer.grant)).toStrictEqual([]);
  },
);

test('#findGrantAuthority puts no limit on a host-wide caller', () => {
  expect(findGrantAuthority(buildMockCaller(), 'gh')).toBeNull();
});

test('#findGrantAuthority gives a caller with patterns its token and the listed generation', () => {
  const caller = buildMockCaller({
    imps: ['dev-*'],
    grantable: [{ name: 'gh', generation: 'gen-gh' }],
  });

  expect(findGrantAuthority(caller, 'gh')).toStrictEqual({
    tokenId: String(caller.tokenId),
    generation: 'gen-gh',
  });
});

test('#findGrantAuthority throws for a secret the caller’s list does not name', () => {
  const caller = buildMockCaller({ imps: ['dev-*'], grantable: [] });

  expect(() => findGrantAuthority(caller, 'gh')).toThrowWithMessage(
    Error,
    `token ${caller.name} reached a grant of gh it may not make`,
  );
});

test('#findGrantAuthority throws for a caller with patterns and no token', () => {
  const caller = buildMockCaller({
    kind: 'tailnet',
    tokenId: null,
    imps: ['dev-*'],
    grantable: [{ name: 'gh', generation: 'gen-gh' }],
  });

  expect(() => findGrantAuthority(caller, 'gh')).toThrowWithMessage(
    Error,
    `tailnet ${caller.name} reached a grant of gh it may not make`,
  );
});

test('#findForkAuthority puts no limit on a host-wide caller', () => {
  expect(findForkAuthority(buildMockCaller())).toBeNull();
});

test('#findForkAuthority gives a caller with patterns its token and its list', () => {
  const caller = buildMockCaller({
    imps: ['dev-*'],
    grantable: [{ name: 'gh', generation: 'gen-gh' }],
  });

  expect(findForkAuthority(caller)).toStrictEqual({
    tokenId: caller.tokenId,
    grantable: [{ name: 'gh', generation: 'gen-gh' }],
  });
});

test.each([
  [{ name: 'dev-a' }, 'name', 'dev-a'],
  [{ name: 7 }, 'name', null],
  [{}, 'name', null],
  ['dev-a', 'name', null],
  [null, 'name', null],
])('#readField reads from %p the field %s as %p', (input, field, value) => {
  expect(readField(input, field)).toBe(value);
});
