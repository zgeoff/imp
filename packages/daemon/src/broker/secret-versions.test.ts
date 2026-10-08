import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { buildMockBrokerRule } from '@imp/api/test-utils/build-mock-broker-rule';
import { invariant } from '@imp/test-utils/invariant';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { sql } from 'kysely';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { findSecret, upsertSecret } from '../db/secrets';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { createBroker } from './broker-service';
import { buildValueFile, createSecretFiles } from './secret-files';

// Each value is an immutable file that the secret's row names; a rotation
// keeps the binding and its grants, a rebind drops them
// (docs/guides/connectors.md#rotate-or-rebind).

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'secret-versions-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // no jailer, no boot template; each resolver takes a free port; a new
  // disk stays the size of its image, as small as /tmp needs
  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    }),
    defaultDiskBytes: 0,
  };

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  // the default image, which every imp the tests create boots
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const vmm = buildStubVmm();
  const logs: string[] = [];

  const impd = await createImpd(config, {
    db,
    rootToken: 'root-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: (message) => {
      logs.push(message);
    },
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },
    egress: {
      runNft: () => Promise.resolve(),
      flushConnections: () => Promise.resolve(),
      flushPair: () => Promise.resolve(),
      readForwardRules: () => Promise.resolve(''),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
      readConnected4: () => Promise.resolve(['172.17.0.0/16']),
      readConnected6: () => Promise.resolve([]),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
    },
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return { stack, config, db, dataDir, logs, impd, client };
}

test('it keeps the generation and the grants through a rotation that reorders the hosts', async () => {
  const ctx = await setupTest();

  const ruleA = buildMockBrokerRule({ host: 'a.example.com' });
  const ruleB = buildMockBrokerRule({ host: 'b.example.com' });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules: [ruleA, ruleB] });
  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const before = await findSecret(ctx.db, 'api');

  invariant(before);

  const rotated = await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules: [ruleB, ruleA],
    replace: true,
  });

  const after = await findSecret(ctx.db, 'api');

  invariant(after);

  const dev = await findImpByName(ctx.db, 'dev');

  invariant(dev);

  const isGranted = await ctx.impd.broker.isGranted(dev.id, 'b.example.com');
  const value = await readFile(join(ctx.dataDir, 'secrets', after.valueFile), 'utf8');
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(rotated.droppedGrants).toBe(0);
  expect(after.generation).toBe(before.generation);
  expect(value).toBe('v2');
  expect(files).toStrictEqual([after.valueFile]);
  expect(isGranted).toBeTrue();
});

test('it refuses a changed binding without rebind and changes nothing', async () => {
  const ctx = await setupTest();

  const rules = [
    buildMockBrokerRule({ host: 'a.example.com' }),
    buildMockBrokerRule({ host: 'b.example.com' }),
  ];

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });
  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const before = await findSecret(ctx.db, 'api');

  const refused = ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules: [buildMockBrokerRule({ host: 'c.example.com' })],
    replace: true,
  });

  expect(refused).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'secret', name: 'api', reason: 'binding_changed' },
  });

  invariant(before);

  const after = await findSecret(ctx.db, 'api');
  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const grants = await ctx.client.grants.list({ name: 'dev' });

  expect(after).toStrictEqual(before);
  expect(files).toStrictEqual([before.valueFile]);
  expect(grants).toStrictEqual(['api']);
});

test('it takes an upstream written another way as the same binding', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const rotated = await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081/' }),
    ],
    replace: true,
  });

  expect(rotated.droppedGrants).toBe(0);

  expect(rotated.rules).toStrictEqual([
    {
      host: 'svc.imp.internal',
      header: 'authorization',
      scheme: 'bearer',
      upstream: 'http://172.17.0.1:18081',
    },
  ]);
});

test('it refuses another upstream without rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081' })],
  });

  expect(
    ctx.client.secrets.add({
      name: 'api',
      kind: 'custom',
      value: 'v2',
      rules: [
        buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18082' }),
      ],
      replace: true,
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT', data: { reason: 'binding_changed' } });
});

test('it refuses dropping the upstream without rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081' })],
  });

  expect(
    ctx.client.secrets.add({
      name: 'api',
      kind: 'custom',
      value: 'v2',
      rules: [buildMockBrokerRule({ host: 'svc.imp.internal' })],
      replace: true,
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT', data: { reason: 'binding_changed' } });
});

test('it moves the upstream and drops the grant on a rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const rebound = await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'https://other.example.com' }),
    ],
    replace: true,
    rebind: true,
  });

  expect(rebound.droppedGrants).toBe(1);

  expect(rebound.rules).toStrictEqual([
    {
      host: 'svc.imp.internal',
      header: 'authorization',
      scheme: 'bearer',
      upstream: 'https://other.example.com',
    },
  ]);
});

test('it takes a new generation and drops every grant of the secret on a rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.create({ name: 'dev-2' });

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'a.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'api' });
  await ctx.client.grants.add({ name: 'dev-2', secret: 'api' });

  const before = await findSecret(ctx.db, 'api');

  invariant(before);

  const rebound = await ctx.client.secrets.add({
    name: 'api',
    kind: 'github',
    value: 'v2',
    replace: true,
    rebind: true,
  });

  const after = await findSecret(ctx.db, 'api');

  invariant(after);

  const rows = await ctx.db.selectFrom('grants').selectAll().execute();
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(rebound.droppedGrants).toBe(2);
  expect(rebound.imps).toStrictEqual([]);
  expect(rows).toStrictEqual([]);
  expect(after.generation).not.toBe(before.generation);
  expect(files).toStrictEqual([after.valueFile]);
});

test('it gives no credential for a grant of another generation', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'a.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  // a row left from another generation, as a bug or a hand edit would
  await ctx.db.updateTable('grants').set({ secret_generation: 'other' }).execute();

  const dev = await findImpByName(ctx.db, 'dev');

  invariant(dev);

  const isGranted = await ctx.impd.broker.isGranted(dev.id, 'a.example.com');
  const grants = await ctx.client.grants.list({ name: 'dev' });

  expect(isGranted).toBeFalse();
  expect(grants).toStrictEqual([]);
});

test('it leaves one file, the row’s, after two rotations at once', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v0', rules });

  await Promise.allSettled([
    ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules, replace: true }),
    ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v2', rules, replace: true }),
  ]);

  const secret = await findSecret(ctx.db, 'api');

  invariant(secret);

  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const value = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  expect(files).toStrictEqual([secret.valueFile]);
  expect(value).toBeOneOf(['v1', 'v2']);
});

test('it leaves only the files rows name after a rotation and a delete at once', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v0', rules });

  await Promise.allSettled([
    ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules, replace: true }),
    ctx.client.secrets.delete({ name: 'api' }),
  ]);

  const named = await ctx.db.selectFrom('secrets').select('value_file').execute();
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(files).toStrictEqual(named.map((row) => row.value_file));
});

test('it leaves only the files rows name after a delete and a create at once', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v0', rules });

  await Promise.allSettled([
    ctx.client.secrets.delete({ name: 'api' }),
    ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules }),
  ]);

  const named = await ctx.db.selectFrom('secrets').select('value_file').execute();
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(files).toStrictEqual(named.map((row) => row.value_file));
});

test('it removes its new file and keeps the old value when a replace fails to commit', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  const before = await findSecret(ctx.db, 'api');

  invariant(before);

  await sql`CREATE TRIGGER fail_update BEFORE UPDATE ON secrets
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END`.execute(ctx.db);

  const replaced = ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules,
    replace: true,
  });

  expect(replaced).rejects.toSatisfy(
    (thrown: unknown) => thrown instanceof Error && !String(thrown).includes('v2'),
  );

  const after = await findSecret(ctx.db, 'api');
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(after).toStrictEqual(before);
  expect(files).toStrictEqual([before.valueFile]);
});

test('it keeps aside a new file whose row never came, on the next start', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  const before = await findSecret(ctx.db, 'api');

  invariant(before);

  // stopped after the write: the new file has no row, and a temp file is left
  createSecretFiles(ctx.dataDir).write(buildValueFile('api'), 'v2');

  await writeFile(join(ctx.dataDir, 'secrets', '.api.half-written'), 'v');

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => restarted.stop());

  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(files).toIncludeSameMembers(['.orphaned', before.valueFile]);
});

test('it removes the old file of a committed replace, on the next start', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  // stopped after the commit: the row names the new file, the old one stays
  const next = buildValueFile('api');

  createSecretFiles(ctx.dataDir).write(next, 'v3');

  await upsertSecret(ctx.db, { name: 'api', kind: 'custom', rules, valueFile: next }, false);

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => restarted.stop());

  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const value = await readFile(join(ctx.dataDir, 'secrets', next), 'utf8');

  expect(files).toStrictEqual([next]);
  expect(value).toBe('v3');
});

test('it logs an old file a replace could not remove, and serves the new value', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  const before = await findSecret(ctx.db, 'api');

  invariant(before);

  // a directory where the old file was: its removal after the commit fails
  const oldFile = join(ctx.dataDir, 'secrets', before.valueFile);

  await rm(oldFile);
  await mkdir(oldFile);
  await writeFile(join(oldFile, 'held'), 'x');

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v2', rules, replace: true });

  const after = await findSecret(ctx.db, 'api');

  invariant(after);

  const value = await readFile(join(ctx.dataDir, 'secrets', after.valueFile), 'utf8');
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(value).toBe('v2');
  expect(files).toIncludeSameMembers([before.valueFile, after.valueFile]);

  expect(ctx.logs).toContainEqual(
    expect.toStartWith('impd: broker: could not remove an old secret value file: '),
  );
});

test('it removes on the next start the old file a replace could not, not keeping it aside', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  const before = await findSecret(ctx.db, 'api');

  invariant(before);

  // a directory where the old file was: its removal after the commit fails
  const oldFile = join(ctx.dataDir, 'secrets', before.valueFile);

  await rm(oldFile);
  await mkdir(oldFile);
  await writeFile(join(oldFile, 'held'), 'x');

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v2', rules, replace: true });

  // the next start finds a file there again
  await rm(oldFile, { recursive: true });
  await writeFile(oldFile, 'v1');

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => restarted.stop());

  const after = await findSecret(ctx.db, 'api');

  invariant(after);

  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(files).toStrictEqual([after.valueFile]);
});
