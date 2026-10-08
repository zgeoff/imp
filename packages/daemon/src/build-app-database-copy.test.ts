import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import packageJson from '../package.json' with { type: 'json' };
import { listApiCalls } from './db/api-audit';
import type { ImpDatabase } from './db/open-database';
import { MIGRATIONS } from './db/run-migrations';
import { buildTestApp, setupImpTest } from './imps/test-imps';

// system.copyDatabase through the API (docs/guides/operations.md#database-copy-and-restore)

const LAST_MIGRATION = Object.keys(MIGRATIONS).toSorted().at(-1);

async function setupTest() {
  const harness = await setupImpTest();

  const root = buildTestApp(harness, harness);

  await harness.createTestImage('base');
  await root.client.imps.create({ name: 'dev' });

  const createClient = async (imps?: readonly string[]) => {
    const made = await root.client.tokens.create({
      name: `t-${String(Math.random()).slice(2, 8)}`,
      scope: 'manage',
      ...(imps !== undefined && { imps: [...imps] }),
    });

    const link = new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: (request) => root.app.handle(request),
    });

    const client: ContractRouterClient<ImpContract> = createORPCClient(link);

    return client;
  };

  return { ...harness, ...root, createClient };
}

// the code of a failed call, or 'ok'
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

// the API audit rows for the procedure, once `count` have landed: each lands
// after its answer
async function waitForAudit(db: ImpDatabase, procedure: string, count: number) {
  const deadline = Date.now() + 5000;

  for (;;) {
    const calls = await listApiCalls(db, null, 100, null);

    const matching = calls.filter((call) => call.procedure === procedure);

    if (matching.length >= count || Date.now() > deadline) {
      return matching;
    }

    await Bun.sleep(5);
  }
}

test('a host-wide copy is a 0600 file under the data directory with the schema version', async () => {
  const ctx = await setupTest();
  const copy = await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  const path = join(ctx.dataDir, 'db-copies', 'before-upgrade.sqlite');

  // a restore script matches these names, in this order
  expect(Object.keys(copy)).toEqual([
    'path',
    'sizeBytes',
    'lastMigration',
    'impVersion',
    'createdAt',
    'integrity',
  ]);

  expect(copy).toMatchObject({
    path,
    lastMigration: LAST_MIGRATION,
    impVersion: packageJson.version,
    integrity: 'ok',
  });

  expect(copy.sizeBytes).toBe(statSync(path).size);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(ctx.dataDir, 'db-copies')).mode & 0o777).toBe(0o700);

  // the copy holds the rows as they were
  const opened = new Database(path, { readonly: true });

  try {
    expect(opened.query('SELECT name FROM imps').all()).toEqual([{ name: 'dev' }]);
  } finally {
    opened.close();
  }

  const audit = await waitForAudit(ctx.db, 'system.copyDatabase', 1);

  expect(audit).toMatchObject([{ actor: 'token', outcome: 'ok' }]);
});

test('a copy without a name is named for the time, and a taken name is a conflict', async () => {
  const ctx = await setupTest();
  const unnamed = await ctx.client.system.copyDatabase({});

  await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  const again = await readCode(ctx.client.system.copyDatabase({ name: 'before-upgrade' }));

  expect(unnamed.path).toMatch(/\/db-copies\/imp-\d{8}-\d{6}\.sqlite$/);
  expect(again).toBe('CONFLICT');
});

test('a name that is not a name, and a caller with imp patterns, are refused', async () => {
  const ctx = await setupTest();
  const scoped = await ctx.createClient(['dev*']);
  const hostWide = await ctx.createClient();

  const codes = await Promise.all([
    readCode(ctx.client.system.copyDatabase({ name: '../../etc/x' })),
    readCode(ctx.client.system.copyDatabase({ name: '/tmp/x' })),
    readCode(scoped.system.copyDatabase({ name: 'scoped' })),
    readCode(hostWide.system.copyDatabase({ name: 'host-wide' })),
  ]);

  expect(codes).toEqual(['BAD_REQUEST', 'BAD_REQUEST', 'FORBIDDEN', 'ok']);
});
