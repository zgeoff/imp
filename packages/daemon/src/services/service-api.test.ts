import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { subscribeImpWrites } from '../db/imp-write-feed';
import { updateImpActivity } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubTimers } from '../test-utils/build-stub-timers';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { readInBackground } from '../test-utils/read-in-background';
import { startStubServiceAgent } from '../test-utils/start-stub-service-agent';
import { createServiceApi } from './service-api';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'service-api-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
  });

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  // the default image, which every create without an image boots
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,

    // the bearer the test's client sends
    rootToken: 'root-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),

    // what system.info reports; the drive's hash names the drive file above
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so a create never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // Firecracker, the kernel and the CPU as this host reports them, which a
    // snapshot must match to load
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
  });

  stack.defer(() => {
    impd.diskUsage.stop();
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return { config, db, dataDir, vmm, impd, client, stack };
}

test('it lists an added service with its command, its source, and only its env keys', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'web', argv: ['node', 'server.js'], env: ['PORT=3000', 'TOKEN=s3cret'] },
  });

  const [web] = agent.services;

  invariant(web);

  agent.services[0] = { ...web, last_exit: { code: 137, signal: 9 } };

  const listed = await ctx.client.services.list({ name: 'dev' });

  expect(agent.requests.find((request) => request.op === 'services.add')?.def).toStrictEqual({
    name: 'web',
    argv: ['node', 'server.js'],
    env: ['PORT=3000', 'TOKEN=s3cret'],
  });

  expect(listed).toStrictEqual({
    services: [
      {
        name: 'web',
        state: 'running',
        pid: 40,
        restarts: 0,
        lastExit: { code: 137, signal: 'SIGKILL' },
        argv: ['node', 'server.js'],
        envKeys: ['PORT', 'TOKEN'],
        cwd: null,
        user: null,
        restart: 'always',
        source: 'api',
        root: false,
      },
    ],
    recorded: true,
  });
});

test('it refuses an add of a service that exists as CONFLICT', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  expect(
    ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } }),
  ).rejects.toMatchObject({ code: 'CONFLICT', data: { kind: 'service', name: 'web' } });
});

test('it replaces a service that exists when the add replaces', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'web', argv: ['httpd', '-v'] },
    replace: true,
  });

  expect(agent.services.map((entry) => entry.def?.argv)).toStrictEqual([['httpd', '-v']]);
});

test('it returns the agent’s refusal of a command as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  expect(
    ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['bad'] } }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses a remove of a service the agent lacks as NOT_FOUND', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  expect(ctx.client.services.remove({ name: 'dev', service: 'web' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'service', name: 'web' },
  });
});

test('it refuses a restart of a service the agent lacks as NOT_FOUND', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  expect(ctx.client.services.restart({ name: 'dev', service: 'web' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'service', name: 'web' },
  });
});

test.each([
  ['../x', 'a path'],
  ['a_b', 'an underscore'],
  ['a.b', 'a dot'],
  ['Web', 'a capital'],
  [`a${'b'.repeat(63)}`, '64 characters'],
])('it refuses the service name %s, with %s, before the agent', async (service) => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const added = ctx.client.services.add({ name: 'dev', service: { name: service, argv: ['x'] } });

  expect(added).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(agent.requests).toStrictEqual([]);
});

test('it refuses a remove of a service name with a slash before the agent', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const removed = ctx.client.services.remove({ name: 'dev', service: 'a/b' });

  expect(removed).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(agent.requests).toStrictEqual([]);
});

test('it refuses an exec-scope add of a service that runs as root as FORBIDDEN', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${token.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  expect(
    exec.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'], user: 'root' } }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });

  expect(agent.services).toStrictEqual([]);
});

test('it adds, restarts and removes an exec-scope service that runs as the image user', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${token.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  await exec.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await exec.services.add({ name: 'dev', service: { name: 'job', argv: ['job'], user: 'dev' } });
  await exec.services.restart({ name: 'dev', service: 'web' });
  await exec.services.remove({ name: 'dev', service: 'job' });

  expect(agent.services.map((service) => service.name)).toStrictEqual(['web']);

  expect(agent.requests.map((request) => request.op)).toIncludeAllMembers([
    'services.add',
    'services.restart',
    'services.remove',
  ]);
});

test('it refuses an exec-scope remove of a service that runs as root as FORBIDDEN', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'db', argv: ['postgres'], user: 'root' },
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${token.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  expect(exec.services.remove({ name: 'dev', service: 'db' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });

  expect(agent.services.map((service) => service.name)).toStrictEqual(['db']);
});

test('it refuses an exec-scope restart of a service that runs as root as FORBIDDEN', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'db', argv: ['postgres'], user: 'root' },
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${token.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  expect(exec.services.restart({ name: 'dev', service: 'db' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });

  expect(agent.requests.map((request) => request.op)).not.toContain('services.restart');
});

test('it refuses an exec-scope replace of a service that runs as root as FORBIDDEN', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'db', argv: ['postgres'], user: 'root' },
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${token.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  expect(
    exec.services.add({ name: 'dev', service: { name: 'db', argv: ['postgres'] }, replace: true }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });

  expect(agent.services.map((service) => service.def?.user)).toStrictEqual(['root']);
});

test('it refuses an exec-scope restart of a service not started yet as FORBIDDEN', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${token.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  // not started yet, so its user is unknown
  expect(exec.services.restart({ name: 'dev', service: 'late' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it refuses an add on an agent from before the services API as AGENT_OUTDATED', async () => {
  const ctx = await setupTest();

  // each boot and wake reports it
  ctx.vmm.agent.version = '0.9.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: false,
    stack: ctx.stack,
  });

  expect(
    ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('it lists the image’s services as root on an agent from before the services API', async () => {
  const ctx = await setupTest();

  // each boot and wake reports it
  ctx.vmm.agent.version = '0.9.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: false,
    stack: ctx.stack,
  });

  agent.services.push({ name: 'dockerd', state: 'running', pid: 212, restarts: 0 });

  const listed = await ctx.client.services.list({ name: 'dev' });

  expect(listed.services).toMatchObject([{ name: 'dockerd', source: 'image', root: true }]);
});

test('it sends one service’s log, 100 lines by default', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.writeLog('web', 'GET /\nGET /favicon.ico\n');

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web' });
  const events = await Array.fromAsync(stream);

  expect(events).toStrictEqual([
    { type: 'log', service: 'web', text: 'GET /\nGET /favicon.ico\n' },
  ]);

  expect(agent.requests.at(-1)).toStrictEqual({
    op: 'services.logs',
    service: 'web',
    lines: 100,
    follow: false,
  });
});

test('it shares 10 000 lines among every service’s log', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.services.add({ name: 'dev', service: { name: 'db', argv: ['postgres'] } });

  const stream = await ctx.client.services.logs({ name: 'dev', lines: 100_000 });
  const events = await Array.fromAsync(stream);

  const asked = agent.requests.filter((request) => request.op === 'services.logs');

  expect(events).toStrictEqual([]);
  expect(asked.map((request) => request.lines)).toStrictEqual([5000, 5000]);
});

test('it merges a follow of every service, and closes each when the reader stops', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.services.add({ name: 'dev', service: { name: 'db', argv: ['postgres'] } });

  agent.writeLog('web', 'web line\n');
  agent.writeLog('db', 'db line\n');

  const stream = await ctx.client.services.logs({ name: 'dev', follow: true, lines: 5 });

  const iterator = stream[Symbol.asyncIterator]();

  const first = await iterator.next();
  const second = await iterator.next();

  await iterator.return?.();

  await waitFor(() => {
    if (agent.follows.length !== 2 || agent.follows.some((follow) => !follow.isClosed)) {
      throw new Error('a follow is still open');
    }
  });

  expect([first.value, second.value]).toIncludeSameMembers([
    { type: 'log', service: 'web', text: 'web line\n' },
    { type: 'log', service: 'db', text: 'db line\n' },
  ]);
});

test('it waits out a sleep in a follow without a wake, and goes on from its cursor', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.writeLog('web', 'one\n');

  const before = await ctx.client.imps.get({ name: 'dev' });
  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();

  const one = await iterator.next();

  // the VM goes to sleep and its connections end; a line the stream had
  // not sent yet waits in the log
  await ctx.client.imps.sleep({ name: 'dev' });

  agent.stopFollows();
  agent.writeLog('web', 'two\n');

  const sleeping = await iterator.next();
  const asleep = await ctx.client.imps.get({ name: 'dev' });

  await ctx.client.imps.wake({ name: 'dev' });

  const awake = await iterator.next();
  const two = await iterator.next();

  agent.writeLog('web', 'three\n');

  const three = await iterator.next();

  await iterator.return?.();

  const resumed = agent.requests.findLast((request) => request.op === 'services.logs');

  expect(one.value).toStrictEqual({ type: 'log', service: 'web', text: 'one\n' });
  expect(sleeping.value).toStrictEqual({ type: 'sleeping', state: 'sleeping' });
  expect(awake.value).toStrictEqual({ type: 'awake' });
  expect(two.value).toStrictEqual({ type: 'log', service: 'web', text: 'two\n' });
  expect(three.value).toStrictEqual({ type: 'log', service: 'web', text: 'three\n' });
  expect(asleep.state).toBe('sleeping');
  expect(asleep.lastActiveAt).toStrictEqual(before.lastActiveAt);
  expect(ctx.vmm.wakes).toHaveLength(1);
  expect(resumed?.cursor).toStrictEqual({ inode: 7, offset: 4 });
});

test('it leaves a sleeping imp asleep through a follow', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.imps.sleep({ name: 'dev' });

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();

  const first = await iterator.next();

  await iterator.return?.();

  const after = await ctx.client.imps.get({ name: 'dev' });

  expect(first.value).toStrictEqual({ type: 'sleeping', state: 'sleeping' });
  expect(after.state).toBe('sleeping');
  expect(ctx.vmm.wakes).toStrictEqual([]);
});

test('it lists a sleeping imp’s services as its sleep recorded them, and wakes nothing', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.imps.sleep({ name: 'dev' });

  const asleep = await ctx.client.services.list({ name: 'dev' });
  const after = await ctx.client.imps.get({ name: 'dev' });

  expect(asleep.services.map((service) => [service.name, service.state])).toStrictEqual([
    ['web', 'running'],
  ]);

  expect(asleep.recorded).toBe(true);
  expect(after.state).toBe('sleeping');
  expect(ctx.vmm.wakes).toStrictEqual([]);
});

test('it refuses a list of a stopped imp’s services as INVALID_STATE', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.imps.stop({ name: 'dev' });

  expect(ctx.client.services.list({ name: 'dev' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
});

test('it lists no services, and says it recorded none, for a sleep the agent gave no list', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.failing.list = true;

  await ctx.client.imps.sleep({ name: 'dev' });

  const asleep = await ctx.client.services.list({ name: 'dev' });

  expect(asleep).toStrictEqual({ services: [], recorded: false });
});

test('it keeps a character that a sleep splits whole in a follow', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  // é is 0xc3 0xa9: the sleep falls between its two bytes
  agent.writeLog('web', new Uint8Array([0x61, 0xc3]));

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();

  const first = await iterator.next();

  await ctx.client.imps.sleep({ name: 'dev' });

  agent.stopFollows();
  agent.writeLog('web', new Uint8Array([0xa9, 0x0a]));

  const sleeping = await iterator.next();

  await ctx.client.imps.wake({ name: 'dev' });

  const awake = await iterator.next();
  const rest = await iterator.next();

  await iterator.return?.();

  expect(first.value).toStrictEqual({ type: 'log', service: 'web', text: 'a' });
  expect(sleeping.value).toStrictEqual({ type: 'sleeping', state: 'sleeping' });
  expect(awake.value).toStrictEqual({ type: 'awake' });
  expect(rest.value).toStrictEqual({ type: 'log', service: 'web', text: 'é\n' });
});

test('it looks again after the short retry, not the long recheck, while a lifecycle step holds a running imp', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  const timers = buildStubTimers();

  // impd's own services API over its runtime, with timers the test fires
  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    startTimer: timers.startTimer,
  });

  const stream = await api.openServiceLogs('dev', { service: 'web', lines: 100, follow: true });

  // before impd and its database go
  ctx.stack.defer(async () => {
    await stream.return?.();
  });

  // a step such as a checkpoint holds the running imp until released
  const release = Promise.withResolvers<void>();
  const held = ctx.impd.imps.lockImp('dev', () => release.promise);

  agent.stopFollows();

  const pausing = stream.next();

  // the dropped connection's retry, then the look that finds the imp held
  await waitFor(() => {
    if (timers.readPendingMs().length === 0) {
      throw new Error('no retry yet');
    }
  });

  timers.firePending();

  const paused = await pausing;

  const resuming = stream.next();

  await waitFor(() => {
    if (timers.readPendingMs().length === 0) {
      throw new Error('no wait yet');
    }
  });

  const pendingMs = timers.readPendingMs();

  release.resolve();

  await held;

  timers.firePending();

  const resumed = await resuming;

  expect(paused.value).toStrictEqual({ type: 'sleeping', state: 'running' });
  expect(pendingMs).toStrictEqual([500]);
  expect(resumed.value).toStrictEqual({ type: 'awake' });
});

test('it goes on with a follow when the wake’s event comes before the wake lets go', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  // a write per wake: the event then reaches the follow while the wake
  // still holds the imp
  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    if (write.kind === 'changed' && write.reason === 'woke') {
      void updateImpActivity(ctx.db, write.imp.id, new Date());
    }
  });

  onTestFinished(unsubscribe);

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();

  await ctx.client.imps.sleep({ name: 'dev' });

  agent.stopFollows();

  const asleep = await iterator.next();

  await ctx.client.imps.wake({ name: 'dev' });

  const awake = await iterator.next();

  await iterator.return?.();

  expect(asleep.value).toStrictEqual({ type: 'sleeping', state: 'sleeping' });
  expect(awake.value).toStrictEqual({ type: 'awake' });
});

test('it ends a follow with the error once its log fails to open five times in a row', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.writeLog('web', 'one\n');

  const timers = buildStubTimers();

  // impd's own services API over its runtime, with timers the test fires
  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    startTimer: timers.startTimer,
  });

  const stream = await api.openServiceLogs('dev', { service: 'web', lines: 100, follow: true });
  const first = await stream.next();

  // the connection drops while the imp runs, and every open after it fails
  agent.failing.logs = true;

  agent.stopFollows();

  const reading = readInBackground(stream);

  // each failed open waits the retry; the follow looks again when it fires
  await waitFor(() => {
    timers.firePending();

    if (agent.requests.filter((request) => request.op === 'services.logs').length < 6) {
      throw new Error('fewer than 6 opens');
    }
  });

  const ended = await reading.ended;

  const opens = agent.requests.filter((request) => request.op === 'services.logs');

  expect(first.value).toStrictEqual({ type: 'log', service: 'web', text: 'one\n' });
  expect(ended).toMatchObject({ code: 'INTERNAL' });
  expect(reading.items).toStrictEqual([]);
  expect(opens).toHaveLength(6);
});

test('it lets a list wait out a step that holds a running imp', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  agent.services.push({ name: 'web', state: 'running', pid: 40, restarts: 0 });

  const timers = buildStubTimers();

  // impd's own services API over its runtime, with timers the test fires
  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    now: () => 0,
    startTimer: timers.startTimer,
  });

  const release = Promise.withResolvers<void>();
  const held = ctx.impd.imps.lockImp('dev', () => release.promise);
  const listing = api.listServices('dev');

  await waitFor(() => {
    if (timers.readPendingMs().length === 0) {
      throw new Error('no wait yet');
    }
  });

  release.resolve();

  await held;

  timers.firePending();

  const listed = await listing;

  expect(listed.services.map((service) => service.name)).toStrictEqual(['web']);
});

test('it refuses a list as INVALID_STATE once a step holds a running imp past 10 s', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const timers = buildStubTimers();
  const clock = { ms: 0 };

  // impd's own services API over its runtime, with a clock and timers the
  // test moves
  const api = createServiceApi({
    runtime: ctx.impd.imps,
    events: ctx.impd.imps.events,
    readSleptServices: (record) =>
      readSnapshotMeta(buildImpPaths(ctx.dataDir, record.id))?.services,
    now: () => clock.ms,
    startTimer: timers.startTimer,
  });

  const release = Promise.withResolvers<void>();
  const held = ctx.impd.imps.lockImp('dev', () => release.promise);

  // before impd and its database go
  ctx.stack.defer(async () => {
    release.resolve();

    await held;
  });

  const listing = api.listServices('dev');

  await waitFor(() => {
    if (timers.readPendingMs().length === 0) {
      throw new Error('no wait yet');
    }
  });

  clock.ms = 10_001;

  timers.firePending();

  expect(listing).rejects.toMatchObject({ code: 'INVALID_STATE' });
});

test('it ends a follow when the imp is destroyed', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.imps.sleep({ name: 'dev' });

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const reading = readInBackground(stream);

  await waitFor(() => {
    if (reading.items.length === 0) {
      throw new Error('no event yet');
    }
  });

  await ctx.client.imps.destroy({ name: 'dev' });

  const ended = await reading.ended;

  expect(ended).toBeNull();
  expect(reading.items).toStrictEqual([{ type: 'sleeping', state: 'sleeping' }]);
});

test('it ends a follow with restarting when impd restarts', async () => {
  const ctx = await setupTest();

  // an agent with the services API, which each boot and wake reports
  ctx.vmm.agent.version = '0.10.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsServices: true,
    stack: ctx.stack,
  });

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  agent.writeLog('web', 'one\n');

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const reading = readInBackground(stream);

  await waitFor(() => {
    if (reading.items.length === 0) {
      throw new Error('no line yet');
    }
  });

  ctx.impd.imps.endLogFollows();

  const ended = await reading.ended;

  expect(ended).toBeNull();

  expect(reading.items).toStrictEqual([
    { type: 'log', service: 'web', text: 'one\n' },
    { type: 'restarting' },
  ]);
});
