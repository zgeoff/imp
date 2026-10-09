import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiCall, ImpEvent, Scope } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import { buildApiListenOptions } from './api-listen-options';
import { PROCEDURE_ACCESS } from './auth/access-policy';
import type { TailnetPeer } from './auth/tailnet-identity';
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import { listApiCalls } from './db/api-audit';
import { createImage } from './db/images';
import { openDatabase } from './db/open-database';
import { PEER_HEADER } from './proxy/forwarded-peers';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildStubExecGuest } from './test-utils/build-stub-exec-guest';
import { buildStubVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';
import { startStubExecAgent } from './test-utils/start-stub-exec-agent';
import { tryExecSocket, tryTunnelSocket } from './test-utils/try-impd-sockets';

interface SetupOptions {
  // impd's environment past what every test boots with
  readonly env?: Readonly<Record<string, string>>;

  // `tailscale whois`; nobody on the tailnet by default
  readonly whois?: (address: string) => Promise<TailnetPeer | null>;
}

// impd's real app on stub VMs, reached in process and on a loopback port
// for its sockets, with a root client for the scenario
async function setupTest(options: SetupOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'build-app-tokens-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
      ...options.env,
    }),

    // a new disk stays the size of its image, since a template's clone
    // copies every byte of the disk
    defaultDiskBytes: 0,
  };

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,

    // the bearer the root client sends
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

    // Firecracker, the kernel and the CPU as this host reports them
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

    // this host is no tailnet node
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    whois: options.whois ?? (() => Promise.resolve(null)),
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

  // as main.ts listens, on a free loopback port: /exec and /tunnel need a socket
  const server = impd.api.app.listen({
    ...buildApiListenOptions(config),
    port: 0,
    hostname: '127.0.0.1',
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  // the image every imps.create boots when it names none
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const sendToImpd = (request: Request) => impd.api.app.handle(request);

  return {
    db,
    dataDir,
    impd,
    stack,
    port: String(server.server?.port),
    sendToImpd,
    client: createImpClient({ url: 'http://impd.test', token: 'root-token', fetch: sendToImpd }),
  };
}

// The access check runs before input validation, so each procedure is called
// with an empty input and a refusal is FORBIDDEN, not BAD_REQUEST.
test('it refuses every procedure to a token whose scope is below what it needs', async () => {
  const ctx = await setupTest();

  const scopes: readonly Scope[] = ['read', 'exec', 'manage'];

  const clients = await Promise.all(
    scopes.map(async (scope) => {
      const made = await ctx.client.tokens.create({ name: `scope-${scope}`, scope });

      return createImpClient({
        url: 'http://impd.test',
        token: made.secret,
        fetch: ctx.sendToImpd,
      });
    }),
  );

  // each procedure with each scope below the one it needs
  const cases = Object.entries(PROCEDURE_ACCESS).flatMap(([path, access]) =>
    scopes.slice(0, scopes.indexOf(access.scope)).map((scope) => ({ path, scope })),
  );

  const outcomes = await Promise.allSettled(
    cases.map(async (entry) => {
      const procedure = z
        .function()
        .parse(
          entry.path
            .split('.')
            .reduce<unknown>(
              (node, key) => Reflect.get(new Object(node), key),
              clients[scopes.indexOf(entry.scope)],
            ),
        );

      const answer: unknown = await Reflect.apply(procedure, undefined, [{}]);

      return answer;
    }),
  );

  expect(cases.length).toBeGreaterThan(30);

  expect(cases.map((entry, index) => [entry.path, entry.scope, outcomes[index]])).toMatchObject(
    cases.map((entry) => [
      entry.path,
      entry.scope,
      { status: 'rejected', reason: { code: 'FORBIDDEN' } },
    ]),
  );
});

test('it refuses every host-wide procedure to a manage token limited to some imps', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'limited',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const hostPaths = Object.entries(PROCEDURE_ACCESS)
    .filter(([, access]) => access.on === 'host')
    .map(([path]) => path);

  const outcomes = await Promise.allSettled(
    hostPaths.map(async (path) => {
      const procedure = z
        .function()
        .parse(
          path
            .split('.')
            .reduce<unknown>((node, key) => Reflect.get(new Object(node), key), limited),
        );

      const answer: unknown = await Reflect.apply(procedure, undefined, [{}]);

      return answer;
    }),
  );

  expect(hostPaths).toContain('secrets.add');

  expect(hostPaths.map((path, index) => [path, outcomes[index]])).toMatchObject(
    hostPaths.map((path) => [path, { status: 'rejected', reason: { code: 'FORBIDDEN' } }]),
  );
});

test('it answers a create with the token and a secret in the token format', async () => {
  const ctx = await setupTest();

  const made: unknown = await ctx.client.tokens.create({
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
  });

  expect(made).toStrictEqual({
    secret: expect.stringMatching(/^imp_[\w-]{16}\.[\w-]{43}$/) as unknown,
    token: {
      name: 'ci',
      scope: 'exec',
      imps: ['dev-*'],
      sshKeys: [],
      grantable: [],
      createdAt: expect.any(Date) as unknown,
    },
  });
});

test('it lists a token without its secret', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });
  const listed = await ctx.client.tokens.list();

  expect(listed).toStrictEqual([made.token]);
  expect(JSON.stringify(listed)).not.toContain(made.secret.split('.')[1]);
});

test('it tells a token who it is', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  const ci = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const identity = await ci.tokens.whoami();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [],
  });
});

test('it refuses a token with the name of another with a conflict', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  expect(ctx.client.tokens.create({ name: 'ci', scope: 'read' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('it refuses a token named root with a conflict', async () => {
  const ctx = await setupTest();

  expect(ctx.client.tokens.create({ name: 'root', scope: 'read' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('it refuses a removed token', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const ci = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await ctx.client.tokens.delete({ name: 'ci' });

  expect(ci.system.info()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

test('it lists no token once the only one is removed', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });
  await ctx.client.tokens.delete({ name: 'ci' });

  const left = await ctx.client.tokens.list();

  expect(left).toStrictEqual([]);
});

test('it lists a token limited to dev-* only its imps', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const imps = await dev.imps.list();

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev-a']);
});

test('it lists a token limited to dev-* a secret’s grants on its imps only', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'prod', secret: 'gh' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const secrets = await dev.secrets.list();

  expect(secrets.map((secret) => secret.imps)).toStrictEqual([['dev-a']]);
});

test('it refuses a token limited to dev-* a stop of another imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.imps.stop({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a token limited to dev-* a create that leaves the name to impd', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.imps.create({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a token limited to dev-* a create of an imp outside its pattern', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.imps.create({ name: 'prod-2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a token limited to dev-* a grant of a host secret', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.grants.add({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it refuses a token limited to dev-* another imp’s audit events', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.audit.list({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a token limited to dev-* another imp’s API calls', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.audit.calls({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it lists a token limited to dev-* only the API calls on its imps', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await dev.imps.stop({ name: 'dev-a' });

  // each audit row lands after its answer; root's calls include host-wide
  // ones, on no imp
  const calls = await waitFor(async () => {
    const listed = await listApiCalls(ctx.db, null, 100, null);

    expect(listed).toPartiallyContain({ procedure: 'imps.stop', actorName: 'dev' });

    return listed;
  });

  const seen = await dev.audit.calls({});

  expect(calls).toSatisfyAny((call: Readonly<ApiCall>) => call.imp === undefined);
  expect(seen).toSatisfyAll((call: Readonly<ApiCall>) => call.imp?.startsWith('dev-') === true);

  expect(seen).toPartiallyContain({
    procedure: 'imps.stop',
    outcome: 'ok',
    actor: 'token',
    actorName: 'dev',
    imp: 'dev-a',
  });
});

test('it refuses a token limited to dev-* an imp from another imp’s template', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.images.add({ imp: 'prod', name: 'prod-tpl' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.imps.create({ name: 'dev-copy', image: 'prod-tpl' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it lets a token limited to dev-* make an imp from its own imp’s template', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-src' });
  await ctx.client.images.add({ imp: 'dev-src', name: 'dev-tpl' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const allowed = await dev.imps.create({ name: 'dev-copy', image: 'dev-tpl' });

  expect(allowed.image).toBe('dev-tpl');
});

test('it names in each template’s audit row the imp whose disk it copied', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.imps.create({ name: 'dev-src' });
  await ctx.client.images.add({ imp: 'prod', name: 'prod-tpl' });
  await ctx.client.images.add({ imp: 'dev-src', name: 'dev-tpl' });

  // each audit row lands after its answer
  const adds = await waitFor(async () => {
    const calls = await listApiCalls(ctx.db, null, 100, null);

    const found = calls.filter((call) => call.procedure === 'images.add');

    expect(found).toHaveLength(2);

    return found;
  });

  expect(adds.map((call) => call.imp)).toIncludeSameMembers(['dev-src', 'prod']);
});

test('it streams a limited token the events of its imps only', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'read', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const stream = await dev.events.stream(undefined, { signal: controller.signal });

  const seen: ImpEvent[] = [];

  // reads until the stream ends, when the test aborts it
  const reading = Array.fromAsync(stream, (event) => {
    seen.push(event);

    return event;
  });

  await ctx.client.imps.stop({ name: 'prod' });
  await ctx.client.imps.stop({ name: 'dev-a' });

  // the stream's last event for this test: dev-a's stop, after prod's
  await waitFor(() => {
    expect(seen).toSatisfyAny(
      (event: Readonly<ImpEvent>) =>
        event.ev === 'ImpChanged' && event.imp.name === 'dev-a' && event.imp.state === 'stopped',
    );
  });

  controller.abort();

  await reading;

  expect(seen[0]).toMatchObject({ ev: 'ImpAdded', imp: { name: 'dev-a' } });

  expect(seen).toSatisfyAll(
    (event: Readonly<ImpEvent>) => !JSON.stringify(event).includes('"prod"'),
  );
});

test('it refuses an exec socket to a read token', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });

  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const outcome = await tryExecSocket(ctx.port, '', 'dev-a', {
    authorization: `Bearer ${made.secret}`,
  });

  expect(JSON.parse(outcome)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
});

test('it refuses an exec socket to an exec token for dev-* on another imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'] });

  const outcome = await tryExecSocket(ctx.port, '', 'prod', {
    authorization: `Bearer ${made.secret}`,
  });

  expect(JSON.parse(outcome)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
});

test('it refuses a tunnel to an exec token for dev-* on another imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'] });

  const outcome = await tryTunnelSocket(
    ctx.port,
    '',
    { authorization: `Bearer ${made.secret}` },
    'prod',
  );

  expect(JSON.parse(outcome)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
});

test('it refuses an exec ticket to a read token', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });

  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const reader = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(reader.exec.ticket({ name: 'dev-a' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses an exec ticket to an exec token for dev-* on another imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'] });

  const dev = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(dev.exec.ticket({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it opens nothing for a ticket once its token is removed', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const ci = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const issued = await ci.exec.ticket({ name: 'dev' });

  await ctx.client.tokens.delete({ name: 'ci' });

  const outcome = await tryExecSocket(ctx.port, `ticket=${issued.ticket}`);

  expect(outcome).toBe('rejected');
});

test('it closes a token’s open sockets when the token is removed', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}/tunnel`, {
    headers: { authorization: `Bearer ${made.secret}` },
  });

  onTestFinished(() => {
    socket.close();
  });

  const opened = Promise.withResolvers<undefined>();
  const closed = Promise.withResolvers<CloseEvent>();

  socket.addEventListener('open', () => {
    opened.resolve(undefined);
  });

  socket.addEventListener('close', closed.resolve);

  await opened.promise;

  await ctx.client.tokens.delete({ name: 'ci' });

  const event = await closed.promise;

  // policy violation
  expect(event.code).toBe(1008);
});

// A removal that lands after the token passed its check but before the
// socket opened: the socket must close all the same.
test('it closes at once a socket that opens after its token is revoked', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const tokenId = /^imp_(?<id>[^.]+)\./v.exec(made.secret)?.groups?.['id'];

  invariant(tokenId);

  ctx.impd.revocations.revoke(tokenId);

  const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}/tunnel`, {
    headers: { authorization: `Bearer ${made.secret}` },
  });

  onTestFinished(() => {
    socket.close();
  });

  const closed = Promise.withResolvers<CloseEvent>();

  socket.addEventListener('close', closed.resolve);

  const event = await closed.promise;

  // policy violation
  expect(event.code).toBe(1008);
});

test('it refuses a token limited to no imps at all', async () => {
  const ctx = await setupTest();

  expect(ctx.client.tokens.create({ name: 'none', scope: 'read', imps: [] })).rejects.toMatchObject(
    { code: 'BAD_REQUEST' },
  );
});

test('it refuses a loopback client that names a tailnet address itself', async () => {
  const ctx = await setupTest({
    // alice may exec on dev-* imps
    env: {
      IMP_TAILNET_IDENTITIES:
        '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
    },

    // alice's laptop is the one tailnet peer
    whois: (address) =>
      Promise.resolve(
        new Map([
          [
            '100.101.102.103',
            { login: 'alice@example.com', tags: [], node: 'laptop', stableId: null },
          ],
        ]).get(address) ?? null,
      ),
  });

  const response = await fetch(`http://127.0.0.1:${ctx.port}/rpc/tokens/whoami`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PEER_HEADER]: '100.101.102.103',
      'x-forwarded-for': '100.101.102.103',
    },
  });

  expect(response.status).toBe(401);
});

test('it serves a tailnet identity through a peer handle the wake proxy registered', async () => {
  const ctx = await setupTest({
    // alice may exec on dev-* imps
    env: {
      IMP_TAILNET_IDENTITIES:
        '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
    },

    // alice's laptop is the one tailnet peer
    whois: (address) =>
      Promise.resolve(
        new Map([
          [
            '100.101.102.103',
            { login: 'alice@example.com', tags: [], node: 'laptop', stableId: null },
          ],
        ]).get(address) ?? null,
      ),
  });

  const response = await fetch(`http://127.0.0.1:${ctx.port}/rpc/tokens/whoami`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    },
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(200);

  expect(body).toMatchObject({
    json: { kind: 'tailnet', name: 'alice@example.com' },
  });
});

test('it refuses a tailnet identity an exec socket from a page on an imp’s port', async () => {
  const ctx = await setupTest({
    // alice may exec on dev-* imps
    env: {
      IMP_TAILNET_IDENTITIES:
        '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
    },

    // alice's laptop is the one tailnet peer
    whois: (address) =>
      Promise.resolve(
        new Map([
          [
            '100.101.102.103',
            { login: 'alice@example.com', tags: [], node: 'laptop', stableId: null },
          ],
        ]).get(address) ?? null,
      ),
  });

  await ctx.client.imps.create({ name: 'dev-a' });

  const outcome = await tryExecSocket(ctx.port, '', 'dev-a', {
    [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    origin: 'http://127.0.0.1:20000',
  });

  expect(outcome).toBe('rejected');
});

test('it refuses a tailnet identity a tunnel from a page on an imp’s port', async () => {
  const ctx = await setupTest({
    // alice may exec on dev-* imps
    env: {
      IMP_TAILNET_IDENTITIES:
        '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
    },

    // alice's laptop is the one tailnet peer
    whois: (address) =>
      Promise.resolve(
        new Map([
          [
            '100.101.102.103',
            { login: 'alice@example.com', tags: [], node: 'laptop', stableId: null },
          ],
        ]).get(address) ?? null,
      ),
  });

  await ctx.client.imps.create({ name: 'dev-a' });

  const outcome = await tryTunnelSocket(
    ctx.port,
    '',
    {
      [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
      origin: 'http://127.0.0.1:20000',
    },
    'dev-a',
  );

  expect(outcome).toBe('rejected');
});

test('it opens an exec socket for a tailnet identity from impd’s own page', async () => {
  const ctx = await setupTest({
    // alice may exec on dev-* imps
    env: {
      IMP_TAILNET_IDENTITIES:
        '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
    },

    // alice's laptop is the one tailnet peer
    whois: (address) =>
      Promise.resolve(
        new Map([
          [
            '100.101.102.103',
            { login: 'alice@example.com', tags: [], node: 'laptop', stableId: null },
          ],
        ]).get(address) ?? null,
      ),
  });

  const created = await ctx.client.imps.create({ name: 'dev-a' });

  // the imp's agent, which runs the exec; it closes before impd stops
  const agent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, created.id).vsockSocket,
    buildStubExecGuest(),
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const outcome = await tryExecSocket(ctx.port, '', 'dev-a', {
    [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    origin: `http://127.0.0.1:${ctx.port}`,
  });

  expect(JSON.parse(outcome)).toMatchObject({ type: 'started' });
});
