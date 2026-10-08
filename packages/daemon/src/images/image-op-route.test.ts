import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { updateEnv } from '@imp/test-utils/update-env';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { listApiCalls } from '../db/api-audit';
import { createImage } from '../db/images';
import { openDatabase } from '../db/open-database';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { runChecked } from '../process/run-command';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubDockerCli } from '../test-utils/build-stub-docker-cli';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubDockerEngine } from '../test-utils/start-stub-docker-engine';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'image-op-route-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the engine a host build sends its context to
  const engine = startStubDockerEngine({ dir: dataDir });

  stack.defer(() => engine.stop());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one; adds
  // and builds run on the host's engine, the stubs
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_BUILD_ISOLATION: 'host',
    DOCKER_HOST: engine.dockerHost,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
  });

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const deps: ImpdDeps = {
    db,

    // the bearer the test's client sends
    rootToken: 'root-token',

    // a sparse copy for a reflink: the temp dir is not XFS, and an imp's
    // disk is sparse
    storage: createXfsBackend({
      dataDir,
      cloneFile: async (source, target) => {
        await runChecked(['cp', '--sparse=always', source, target]);
      },
    }),

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
  };

  const impd = await createImpd(config, deps);

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  // the root bearer's client, against impd's own app
  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return {
    db,
    dataDir,
    engine,
    impd,
    client,
  };
}

test('it streams the phases of an add, then the image', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  // the image is not on the host: the add pulls it, then unpacks its export
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['busybox:1.37'],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}`, Config: { Cmd: ['sh'] }, Size: 2 }],
        isOnHost: false,
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  const stream = await ctx.client.images.addStream({ ref: 'busybox:1.37', name: 'box' });
  const events = await Array.fromAsync(stream);

  const phases = events.flatMap((event) => (event.type === 'progress' ? [event.phase] : []));

  expect(phases.filter((phase, index) => phases[index - 1] !== phase)).toStrictEqual([
    'pull',
    'unpack',
  ]);

  expect(events.at(-1)).toMatchObject({
    type: 'image',
    image: { name: 'box', createdAt: expect.any(Date) as unknown },
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it audits a streamed add as ok once it ends', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['busybox:1.37'],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}`, Config: {}, Size: 2 }],
        isOnHost: false,
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  const stream = await ctx.client.images.addStream({ ref: 'busybox:1.37', name: 'box' });

  await Array.fromAsync(stream);

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds;
  });

  expect(calls.map((row) => [row.outcome, row.imp ?? null])).toStrictEqual([['ok', null]]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test("it keeps the reference a streamed add's pull resolved in its audit row", async () => {
  const ctx = await setupTest();

  const pulled = `busybox@sha256:${'d'.repeat(64)}`;

  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['busybox'],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}`, Config: {}, Size: 2, RepoDigests: [pulled] }],
        isOnHost: false,
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  const stream = await ctx.client.images.addStream({ ref: 'busybox', name: 'box' });

  await Array.fromAsync(stream);

  const details = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds.map((row) => row.detail);
  });

  expect(details).toStrictEqual([pulled]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it streams the copy of a template and audits it with its imp', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'source', image: 'base' });

  const stream = await ctx.client.images.addStream({ imp: 'source', name: 'tpl' });
  const events = await Array.fromAsync(stream);

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds;
  });

  expect([
    ...new Set(events.flatMap((event) => (event.type === 'progress' ? [event.phase] : []))),
  ]).toStrictEqual(['copy']);

  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'tpl', source: 'imp' } });
  expect(calls.map((row) => [row.outcome, row.imp ?? null])).toStrictEqual([['ok', 'source']]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it throws a failed add through the stream with a code that keeps its message out', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['busybox:1.37'],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}` }],
        isOnHost: false,
        pull: { stderr: 'pull access denied' },
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const stream = await ctx.client.images.addStream({ ref: 'busybox:1.37' });

  const adding = Array.fromAsync(stream);

  await adding.catch(() => {});

  expect(adding).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(adding).rejects.not.toThrow('pull access denied');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it audits a failed streamed add with its code', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['busybox:1.37'],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}` }],
        isOnHost: false,
        pull: { stderr: 'pull access denied' },
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const stream = await ctx.client.images.addStream({ ref: 'busybox:1.37' });

  expect(Array.fromAsync(stream)).rejects.toThrow();

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds;
  });

  expect(calls.map((row) => [row.outcome, row.imp ?? null])).toStrictEqual([
    ['INTERNAL_SERVER_ERROR', null],
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a streamed add to a read token and audits the refusal', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const reader: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  const adding = reader.images.addStream({ ref: 'busybox:1.37' });

  expect(adding).rejects.toMatchObject({ code: 'FORBIDDEN' });

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds;
  });

  expect(calls.map((row) => row.outcome)).toStrictEqual(['FORBIDDEN']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a streamed build to a read token and audits the refusal', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const reader: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  const building = reader.images.buildStream({ contextDir: '/srv/ctx', name: 'web' });

  expect(building).rejects.toMatchObject({ code: 'FORBIDDEN' });

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.buildStream');

    expect(builds).not.toBeEmpty();

    return builds;
  });

  expect(calls.map((row) => row.outcome)).toStrictEqual(['FORBIDDEN']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it streams the pack, then the build, of a build from a directory', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.dataDir, 'context');

  await mkdir(contextDir);
  await writeFile(join(contextDir, 'Dockerfile'), 'FROM scratch\n');

  // the Dockerfile frontend is on the host already
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] }],
  });

  updateEnv('PATH', docker.path);

  // the engine holds the build until its client goes
  ctx.engine.setAnswer(async (request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    await new Promise((resolve) => {
      request.signal.addEventListener('abort', resolve);
    });

    return new Response(null, { status: 499 });
  });

  const client = new AbortController();

  const events = await ctx.client.images.buildStream(
    { contextDir, name: 'web' },
    { signal: client.signal },
  );

  const first = await events.next();
  const second = await events.next();

  client.abort();

  expect(first.value).toStrictEqual({
    type: 'progress',
    phase: 'pack',
    elapsedMs: expect.any(Number) as unknown,
  });

  expect(second.value).toStrictEqual({
    type: 'progress',
    phase: 'build',
    elapsedMs: expect.any(Number) as unknown,
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it stops the engine build of a streamed build whose client goes, and audits it', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.dataDir, 'context');

  await mkdir(contextDir);
  await writeFile(join(contextDir, 'Dockerfile'), 'FROM scratch\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] }],
  });

  updateEnv('PATH', docker.path);

  const build = { started: false, stopped: false };

  ctx.engine.setAnswer(async (request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    build.started = true;

    await new Promise((resolve) => {
      request.signal.addEventListener('abort', resolve);
    });

    build.stopped = true;

    return new Response(null, { status: 499 });
  });

  const client = new AbortController();

  const events = await ctx.client.images.buildStream(
    { contextDir, name: 'web' },
    { signal: client.signal },
  );

  await events.next();

  await waitFor(() => {
    expect(build.started).toBeTrue();
  });

  client.abort();

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.buildStream');

    expect(builds).not.toBeEmpty();
    expect(build.stopped).toBeTrue();

    return builds.map((row) => row.outcome);
  });

  expect(outcomes).toStrictEqual(['INTERNAL_SERVER_ERROR']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it kills the host pull of a streamed add whose client goes, and audits it', async () => {
  const ctx = await setupTest();

  // the image is not on the host, and its pull hangs until it is killed
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['registry.test/big:1'],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}` }],
        isOnHost: false,
        pull: 'hang',
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const client = new AbortController();

  const events = await ctx.client.images.addStream(
    { ref: 'registry.test/big:1' },
    { signal: client.signal },
  );

  await events.next();

  await waitFor(() => {
    expect(docker.readCalls()).toContain('pull --quiet registry.test/big:1');
  });

  client.abort();

  // the pull sleeps 30 s: only its kill writes the row within the wait
  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds.map((row) => row.outcome);
  });

  expect(outcomes).toStrictEqual(['INTERNAL_SERVER_ERROR']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it stops the engine build of a plain build whose client goes', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.dataDir, 'context');

  await mkdir(contextDir);
  await writeFile(join(contextDir, 'Dockerfile'), 'FROM scratch\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] }],
  });

  updateEnv('PATH', docker.path);

  const build = { started: false, stopped: false };

  ctx.engine.setAnswer(async (request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    build.started = true;

    await new Promise((resolve) => {
      request.signal.addEventListener('abort', resolve);
    });

    build.stopped = true;

    return new Response(null, { status: 499 });
  });

  const client = new AbortController();

  const building = ctx.client.images.build({ contextDir, name: 'web' }, { signal: client.signal });

  await waitFor(() => {
    expect(build.started).toBeTrue();
  });

  client.abort();

  expect(building).rejects.toThrow();

  const stopped = await waitFor(() => {
    expect(build.stopped).toBeTrue();

    return build.stopped;
  });

  expect(stopped).toBeTrue();
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it kills the host pull of a plain add whose client goes, and audits it', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['busybox:1.37'],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}` }],
        isOnHost: false,
        pull: 'hang',
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const client = new AbortController();

  const adding = ctx.client.images.add(
    { ref: 'busybox:1.37', name: 'box' },
    { signal: client.signal },
  );

  await waitFor(() => {
    expect(docker.readCalls()).toContain('pull --quiet busybox:1.37');
  });

  client.abort();

  expect(adding).rejects.toThrow();

  // the pull sleeps 30 s: only its kill writes the row within the wait
  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.add');

    expect(adds).not.toBeEmpty();

    return adds.map((row) => row.outcome);
  });

  expect(outcomes).toStrictEqual(['INTERNAL_SERVER_ERROR']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});
