import { expect, spyOn, test } from 'bun:test';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AUDIT_ROWS_PER_IMP, listAuditEntries, writeAuditEntry } from '../db/broker-audit';
import { findImpByName } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { findSecret } from '../db/secrets';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import type { InstallBundle } from './guest-trust';

const VALUE = 'ghp_SECRETVALUE0123456789';

async function setupTest(options: { readonly installBundle?: InstallBundle } = {}) {
  const harness = await setupImpTest(options);

  await harness.createTestImage('base');

  return { ...harness, ...buildTestApp(harness, harness) };
}

// the file that holds the secret's value now
async function readValuePath(ctx: Readonly<{ db: ImpDatabase; dataDir: string }>, name: string) {
  const secret = await findSecret(ctx.db, name);

  if (secret === undefined) {
    throw new Error(`no secret ${name}`);
  }

  return join(ctx.dataDir, 'secrets', secret.valueFile);
}

async function requireImp(db: ImpDatabase, name: string): Promise<ImpRecord> {
  const imp = await findImpByName(db, name);

  if (imp === undefined) {
    throw new Error(`no imp ${name}`);
  }

  return imp;
}

test('a secret is stored owner-only and never comes back out of the API', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const added = await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const path = await readValuePath(ctx, 'gh');

  expect(readFileSync(path, 'utf8')).toBe(VALUE);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(added).toMatchObject({ name: 'gh', kind: 'github', imps: [] });

  const everything = JSON.stringify([
    added,
    await ctx.client.secrets.list(),
    await ctx.client.grants.list({ name: 'dev' }),
    await ctx.client.imps.list(),
    await ctx.client.imps.get({ name: 'dev' }),
    await ctx.client.system.info(),
  ]);

  expect(everything).not.toContain(VALUE);

  const secrets = await ctx.client.secrets.list();

  expect(secrets).toMatchObject([{ name: 'gh', imps: ['dev'] }]);
});

test('names are checked before they reach the disk, and a taken name needs replace', async () => {
  await using ctx = await setupTest();

  for (const name of ['../etc', 'a/b', '.hidden', 'Upper', '']) {
    const failure = await ctx.client.secrets
      .add({ name, kind: 'github', value: VALUE })
      .catch((error: unknown) => error);

    expect({ name, failure }).toMatchObject({ name, failure: { code: 'BAD_REQUEST' } });
  }

  // a value that could split a header
  const split = await ctx.client.secrets
    .add({ name: 'gh', kind: 'github', value: 'a\r\nx-evil: 1' })
    .catch((error: unknown) => error);

  expect(split).toMatchObject({ code: 'BAD_REQUEST' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });

  const taken = await ctx.client.secrets
    .add({ name: 'gh', kind: 'github', value: 'other' })
    .catch((error: unknown) => error);

  const kept = await readValuePath(ctx, 'gh');

  expect(taken).toMatchObject({ code: 'CONFLICT' });
  expect(readFileSync(kept, 'utf8')).toBe(VALUE);

  // a replace writes a new file, and the old one goes
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'rotated', replace: true });

  const rotated = await readValuePath(ctx, 'gh');

  expect(readFileSync(rotated, 'utf8')).toBe('rotated');
  expect(readdirSync(join(ctx.dataDir, 'secrets'))).toEqual([basename(rotated)]);

  const custom = await ctx.client.secrets
    .add({ name: 'api', kind: 'custom', value: VALUE })
    .catch((error: unknown) => error);

  expect(custom).toMatchObject({ code: 'BAD_REQUEST' });
});

test('a failed write never puts the value in a log or an error', async () => {
  await using ctx = await setupTest();

  // a file where the directory goes: the write fails, even as root
  const dir = join(ctx.dataDir, 'secrets');

  rmSync(dir, { recursive: true });
  writeFileSync(dir, '');

  const logged: string[] = [];

  const spy = spyOn(console, 'error').mockImplementation((...args: readonly unknown[]) => {
    logged.push(
      args
        .map((arg) => (arg instanceof Error ? `${arg.message} ${String(arg.stack)}` : String(arg)))
        .join(' '),
    );
  });

  try {
    const failure = await ctx.client.secrets
      .add({ name: 'gh', kind: 'github', value: VALUE })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure)).not.toContain(VALUE);
    expect(String(failure)).not.toContain(VALUE);
  } finally {
    spy.mockRestore();
  }

  expect(logged.join('\n')).toContain('rpc failed');
  expect(logged.join('\n')).not.toContain(VALUE);

  // the row went with the failed write
  const left = await ctx.client.secrets.list();

  expect(left).toEqual([]);
});

test('grants check the imp, the secret, and one credential per host', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: VALUE,
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
  });

  const noImp = await ctx.client.grants
    .add({ name: 'nope', secret: 'gh' })
    .catch((error: unknown) => error);

  const noSecret = await ctx.client.grants
    .add({ name: 'dev', secret: 'nope' })
    .catch((error: unknown) => error);

  expect(noImp).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'imp' } });
  expect(noSecret).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'secret' } });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const clash = await ctx.client.grants
    .add({ name: 'dev', secret: 'gh-api' })
    .catch((error: unknown) => error);

  expect(clash).toMatchObject({ code: 'CONFLICT' });
  expect(String(clash)).toContain('api.github.com');

  await ctx.client.grants.delete({ name: 'dev', secret: 'gh' });

  const gone = await ctx.client.grants
    .delete({ name: 'dev', secret: 'gh' })
    .catch((error: unknown) => error);

  expect(gone).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'grant' } });
});

test('imp rm and secret rm take their grants along; a fork keeps them', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });
  await ctx.client.secrets.add({ name: 'claude', kind: 'anthropic', value: VALUE });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev', secret: 'claude' });
  await ctx.client.imps.fork({ source: 'dev', name: 'copy' });

  const forkGrants = await ctx.client.grants.list({ name: 'copy' });

  expect(forkGrants).toEqual(['claude', 'gh']);

  await ctx.client.secrets.delete({ name: 'claude' });

  const afterSecretRm = await ctx.client.grants.list({ name: 'dev' });

  expect(afterSecretRm).toEqual(['gh']);

  expect(
    readdirSync(join(ctx.dataDir, 'secrets')).filter((file) => file.startsWith('claude')),
  ).toEqual([]);

  await ctx.client.imps.destroy({ name: 'dev' });
  await ctx.client.imps.create({ name: 'dev' });

  const afterImpRm = await ctx.client.grants.list({ name: 'dev' });

  expect(afterImpRm).toEqual([]);

  const left = await ctx.db.selectFrom('grants').selectAll().execute();

  expect(left).toHaveLength(1);
});

test('an exec gets the broker variables only once the CA is in that boot', async () => {
  const installs: string[] = [];
  const state = { fail: false };

  await using ctx = await setupTest({
    installBundle: (vsockPath) => {
      installs.push(vsockPath);

      return state.fail ? Promise.reject(new Error('no /bin/sh')) : Promise.resolve();
    },
  });

  await ctx.client.imps.create({ name: 'dev' });

  const imp = await requireImp(ctx.db, 'dev');
  const ungranted = await ctx.broker.readExecEnv(imp, '/vsock');

  expect(ungranted).toEqual([]);
  expect(installs).toEqual([]);

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const env = await ctx.broker.readExecEnv(imp, '/vsock');

  expect(env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
  expect(env).toContain('https_proxy=http://10.66.0.1:7081');
  expect(env).toContain('SSL_CERT_FILE=/etc/imp/broker-ca.pem');
  expect(env).toContain('NODE_USE_ENV_PROXY=1');
  expect(env).toContain('GH_TOKEN=imp-broker-placeholder');
  expect(env.join('\n')).not.toContain(VALUE);

  // one install per boot, however many execs
  await ctx.broker.readExecEnv(imp, '/vsock');

  expect(installs).toHaveLength(1);

  // a new boot (another pid) installs again; a failure leaves the exec
  // without the broker rather than with a CA it does not trust
  state.fail = true;

  const rebooted = { ...imp, pid: (imp.pid ?? 0) + 1 };

  const failed = await ctx.broker.readExecEnv(rebooted, '/vsock');

  expect(failed).toEqual([]);
  expect(installs).toHaveLength(2);
  expect(ctx.logs.join('\n')).toContain('broker CA not installed');
});

test('the audit log keeps the newest rows of each imp', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });

  const imp = await requireImp(ctx.db, 'dev');

  for (let index = 0; index < AUDIT_ROWS_PER_IMP + 5; index += 1) {
    await writeAuditEntry(ctx.db, {
      impId: imp.id,
      secretName: 'gh',
      at: new Date(),
      method: 'GET',
      host: 'api.github.com',
      path: `/${String(index)}`,
      status: 200,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 1,
    });
  }

  const rows = await listAuditEntries(ctx.db, imp.id, 2000, null);

  expect(rows).toHaveLength(AUDIT_ROWS_PER_IMP);
  expect(rows[0]?.path).toBe(`/${String(AUDIT_ROWS_PER_IMP + 4)}`);

  const listed = await ctx.client.audit.list({ name: 'dev', limit: 2 });

  expect(listed.map((row) => row.path)).toEqual([
    `/${String(AUDIT_ROWS_PER_IMP + 4)}`,
    `/${String(AUDIT_ROWS_PER_IMP + 3)}`,
  ]);

  // the rows go with the imp
  await ctx.client.imps.destroy({ name: 'dev' });

  const afterRm = await listAuditEntries(ctx.db, null, 10, null);

  expect(afterRm).toEqual([]);
});

test('a fork whose grants cannot be copied is still returned, and the failure logged', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  // the source is gone by the time the grants are copied
  await ctx.broker.createForkGrants('gone', 'dev');

  expect(ctx.logs.join('\n')).toContain('forked without the grants of gone');
});

test('a replace refused for a clash keeps the old value and leaves no new file', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });
  await ctx.client.secrets.add({ name: 'claude', kind: 'anthropic', value: VALUE });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev', secret: 'claude' });

  const before = await readValuePath(ctx, 'claude');

  // claude moving onto gh's host would give dev two credentials for it
  const clash = await ctx.client.secrets
    .add({
      name: 'claude',
      kind: 'custom',
      value: 'other',
      rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
      replace: true,
    })
    .catch((error: unknown) => error);

  const after = await readValuePath(ctx, 'claude');

  const files = readdirSync(join(ctx.dataDir, 'secrets'));

  expect(clash).toMatchObject({ code: 'CONFLICT' });
  expect(after).toBe(before);
  expect(readFileSync(after, 'utf8')).toBe(VALUE);
  expect(files).toHaveLength(2);
});
