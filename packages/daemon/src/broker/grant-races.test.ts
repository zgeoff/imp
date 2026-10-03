import { expect, test } from 'bun:test';
import { listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { listGrantNames, listGrantedRules } from '../db/secrets';
import { buildTestApp, setupImpTest } from '../imps/test-imps';

// Grants made, revoked, copied and changed at the same time: each race ends
// as one serial order would, and no imp ever holds two credentials for one
// host (docs/guides/connectors.md#secrets-and-grants).

const VALUE = 'sk-synthetic-126-race';

async function setupTest() {
  const harness = await setupImpTest();

  await harness.createTestImage('base');

  const ctx = { ...harness, ...buildTestApp(harness, harness) };

  await ctx.client.imps.create({ name: 'dev' });

  // gh and gh-api both cover api.github.com
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: VALUE,
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
  });

  // other, granted to dev, on its own host; then rebound onto gh's host
  const setupOther = async (): Promise<void> => {
    await ctx.client.secrets.add({
      name: 'other',
      kind: 'custom',
      value: VALUE,
      rules: [{ host: 'other.example.com', header: 'authorization', scheme: 'bearer' }],
    });

    await ctx.client.grants.add({ name: 'dev', secret: 'other' });
  };

  const updateOtherHost = () =>
    readCode(
      ctx.client.secrets.add({
        name: 'other',
        kind: 'custom',
        value: `${VALUE}-2`,
        rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
        replace: true,
        rebind: true,
      }),
    );

  return { ...ctx, setupOther, updateOtherHost };
}

// each imp whose grants cover one host twice
async function findDoubleHosts(db: ImpDatabase): Promise<string[]> {
  const doubled: string[] = [];

  const imps = await listImps(db);

  for (const imp of imps) {
    const granted = await listGrantedRules(db, imp.id);

    const hosts = granted.map((each) => each.rule.host);

    for (const host of new Set(hosts)) {
      if (hosts.filter((each) => each === host).length > 1) {
        doubled.push(`${imp.name} ${host}`);
      }
    }
  }

  return doubled;
}

async function readCode(call: Promise<unknown>): Promise<string> {
  try {
    await call;

    return 'ok';
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'thrown';
  }
}

test('two grants that clash, at once: exactly one is made and the other is CONFLICT', async () => {
  await using ctx = await setupTest();

  const codes = await Promise.all([
    readCode(ctx.client.grants.add({ name: 'dev', secret: 'gh' })),
    readCode(ctx.client.grants.add({ name: 'dev', secret: 'gh-api' })),
  ]);

  const left = await ctx.client.grants.list({ name: 'dev' });
  const doubled = await findDoubleHosts(ctx.db);

  expect(codes.toSorted()).toEqual(['CONFLICT', 'ok']);
  expect(left).toHaveLength(1);
  expect(doubled).toEqual([]);
});

test('a grant and a revoke at once end as one of the two orders', async () => {
  await using ctx = await setupTest();

  const [added, removed] = await Promise.all([
    readCode(ctx.client.grants.add({ name: 'dev', secret: 'gh' })),
    readCode(ctx.client.grants.delete({ name: 'dev', secret: 'gh' })),
  ]);

  const left = await ctx.client.grants.list({ name: 'dev' });

  // grant then revoke leaves nothing; revoke first finds no grant
  const serial = [
    { added: 'ok', removed: 'ok', left: [] },
    { added: 'ok', removed: 'NOT_FOUND', left: ['gh'] },
  ];

  expect(serial).toContainEqual({ added, removed, left });
});

test('a grant on a fork while its source’s grants are copied skips the clashing copy', async () => {
  await using ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: VALUE });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.imps.create({ name: 'copy' });

  // the copy as a fork makes it, a grant on the fork, and a grant on the
  // source, all at once
  const codes = await Promise.all([
    readCode(ctx.broker.createForkGrants('dev', 'copy', null)),
    readCode(ctx.client.grants.add({ name: 'copy', secret: 'gh-api' })),
    readCode(ctx.client.grants.add({ name: 'dev', secret: 'npm' })),
  ]);

  const copy = await ctx.client.grants.list({ name: 'copy' });
  const doubled = await findDoubleHosts(ctx.db);

  // the copy never throws; whichever of gh and gh-api came first holds the host
  expect(codes[0]).toBe('ok');
  expect(copy.filter((name) => name.startsWith('gh'))).toHaveLength(1);
  expect(doubled).toEqual([]);

  if (codes[1] === 'ok' && !copy.includes('gh')) {
    expect(ctx.logs.join('\n')).toContain('forked without grant gh of dev');
  }

  // the source's new grant came before the copy or after it, whole
  expect([['gh'], ['gh', 'npm'], ['gh-api'], ['gh-api', 'npm']]).toContainEqual(copy);
});

test('a rebind onto a granted host, before or after that grant, never doubles the host', async () => {
  const outcomes: string[] = [];

  for (const order of ['grant first', 'rebind first']) {
    await using ctx = await setupTest();

    await ctx.setupOther();

    const steps =
      order === 'grant first'
        ? [
            await readCode(ctx.client.grants.add({ name: 'dev', secret: 'gh' })),
            await ctx.updateOtherHost(),
          ]
        : [
            await ctx.updateOtherHost(),
            await readCode(ctx.client.grants.add({ name: 'dev', secret: 'gh' })),
          ];

    const left = await ctx.client.grants.list({ name: 'dev' });
    const doubled = await findDoubleHosts(ctx.db);

    outcomes.push(`${order}: ${steps.join(' ')} -> ${left.join(',')} ${String(doubled.length)}`);
  }

  // the rebind drops other's grant, so neither order clashes
  expect(outcomes).toEqual(['grant first: ok ok -> gh 0', 'rebind first: ok ok -> gh 0']);
});

test('a rebind and a revoke at once end as one of the two orders', async () => {
  await using ctx = await setupTest();

  await ctx.setupOther();

  const [rebound, revoked] = await Promise.all([
    ctx.updateOtherHost(),
    readCode(ctx.client.grants.delete({ name: 'dev', secret: 'other' })),
  ]);

  const left = await ctx.client.grants.list({ name: 'dev' });

  // revoke first, then a rebind with nothing to drop; or the rebind drops
  // the grant and the revoke finds none
  expect(left).toEqual([]);
  expect(rebound).toBe('ok');
  expect(['ok', 'NOT_FOUND']).toContain(revoked);
});

test('a refused or clashing grant leaves what was there, and a retry makes one row', async () => {
  await using ctx = await setupTest();

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const clash = await readCode(ctx.client.grants.add({ name: 'dev', secret: 'gh-api' }));
  const kept = await ctx.client.grants.list({ name: 'dev' });

  expect(clash).toBe('CONFLICT');
  expect(kept).toEqual(['gh']);

  await ctx.client.grants.delete({ name: 'dev', secret: 'gh' });

  const retries = await Promise.all([
    ctx.client.grants.add({ name: 'dev', secret: 'gh-api' }),
    ctx.client.grants.add({ name: 'dev', secret: 'gh-api' }),
  ]);

  expect(retries).toEqual([{}, {}]);

  const imps = await listImps(ctx.db);

  const imp = imps.find((each) => each.name === 'dev');

  const rows = await listGrantNames(ctx.db, imp?.id ?? '');

  expect(rows).toEqual(['gh-api']);
});
