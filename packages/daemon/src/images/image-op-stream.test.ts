import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Image, ImpContract } from '@imp/api';
import { buildMockImage } from '@imp/api/test-utils/build-mock-image';
import { invariant } from '@imp/test-utils/invariant';
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
import {
  buildImagePaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubRepeat } from '../test-utils/build-stub-repeat';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { createStubDockerCli } from '../test-utils/create-stub-docker-cli';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubDockerEngine } from '../test-utils/start-stub-docker-engine';
import { runImageOp } from './image-op-stream';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'image-op-stream-'));

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

test('it sends progress at once and at each phase, then the image', async () => {
  const clock = { now: 0 };
  const phaseReached = Promise.withResolvers<void>();
  const done = Promise.withResolvers<Image>();
  const image = buildMockImage();

  const events = runImageOp(
    async (_signal, report) => {
      await phaseReached.promise;

      clock.now = 4000;

      report.setPhase('unpack');

      return done.promise;
    },
    {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => clock.now,
      record: () => {},
    },
  );

  const first = await events.next();

  phaseReached.resolve();

  const second = await events.next();

  done.resolve(image);

  const third = await events.next();

  expect([first.value, second.value, third.value]).toStrictEqual([
    { type: 'progress', phase: 'pull', elapsedMs: 0 },
    { type: 'progress', phase: 'unpack', elapsedMs: 4000 },
    { type: 'image', image },
  ]);
});

test('it records a null failure for work that ends with its image', async () => {
  const records: unknown[] = [];

  await Array.fromAsync(
    runImageOp(() => Promise.resolve(buildMockImage()), {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: (failure) => {
        records.push(failure);
      },
    }),
  );

  expect(records).toStrictEqual([null]);
});

test('it repeats the progress at each keepalive while the work is silent', async () => {
  const clock = { now: 0 };
  const keepalive = buildStubRepeat();

  const events = runImageOp(() => Promise.withResolvers<Image>().promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 15_000,
    now: () => clock.now,
    record: () => {},
    repeat: keepalive.repeat,
  });

  await events.next();

  const second = events.next();

  await waitFor(() => {
    expect(keepalive.countRunning(15_000)).toBe(1);
  });

  clock.now = 15_000;

  keepalive.tick(15_000);

  const progress = await second;

  expect(progress.value).toStrictEqual({ type: 'progress', phase: 'pull', elapsedMs: 15_000 });
});

test('it throws the failure through the stream and records what was thrown', () => {
  const records: unknown[] = [];

  const failure = new Error('pull denied');

  const collected = Array.fromAsync(
    runImageOp(() => Promise.reject(failure), {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: (recorded) => {
        records.push(recorded);
      },
    }),
  );

  expect(collected).rejects.toBe(failure);
  expect(records).toStrictEqual([failure]);
});

// what oRPC does when the client goes: the stream ends at its yield
test('it writes no audit row when the client leaves before the work ends', async () => {
  const records: unknown[] = [];

  const events = runImageOp(() => Promise.withResolvers<Image>().promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: (failure) => {
      records.push(failure);
    },
  });

  await events.next();
  await events.return(undefined);

  expect(records).toStrictEqual([]);
});

test('it writes the audit row of work the client left once the work ends', async () => {
  const recorded = Promise.withResolvers<unknown>();
  const done = Promise.withResolvers<Image>();

  const events = runImageOp(() => done.promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: (failure) => {
      recorded.resolve(failure);
    },
  });

  await events.next();
  await events.return(undefined);

  done.resolve(buildMockImage());

  expect(recorded.promise).resolves.toBeNull();
});

test('it stops the keepalive timer once the work ends', async () => {
  const done = Promise.withResolvers<Image>();
  const keepalive = buildStubRepeat();

  const events = runImageOp(() => done.promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: () => {},
    repeat: keepalive.repeat,
  });

  await events.next();

  const imageEvent = events.next();

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(1);
  });

  done.resolve(buildMockImage());

  await imageEvent;

  expect(keepalive.countRunning(10_000)).toBe(0);
});

test('it stops the keepalive timer of a wait the next phase ends', async () => {
  const phases: ((phase: 'unpack') => void)[] = [];
  const keepalive = buildStubRepeat();

  const events = runImageOp(
    (_signal, report) => {
      phases.push(report.setPhase);

      return Promise.withResolvers<Image>().promise;
    },
    {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: () => {},
      repeat: keepalive.repeat,
    },
  );

  await events.next();

  const next = events.next();

  const setPhase = await waitFor(() => {
    invariant(phases[0]);

    return phases[0];
  });

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(1);
  });

  setPhase('unpack');

  await next;

  expect(keepalive.countRunning(10_000)).toBe(0);
});

test('it sends the build output as log events in order, before the image', async () => {
  const image = buildMockImage();

  const events = await Array.fromAsync(
    runImageOp(
      (_signal, report) => {
        report.output.emitLog('#4 [2/3] RUN make all');
        report.output.emitLog('#4 cc -o widget main.c');

        return Promise.resolve(image);
      },
      {
        firstPhase: 'build',
        signal: new AbortController().signal,
        keepaliveMs: 10_000,
        now: () => 0,
        record: () => {},
        logs: true,
      },
    ),
  );

  expect(events).toStrictEqual([
    { type: 'progress', phase: 'build', elapsedMs: 0 },
    { type: 'log', text: '#4 [2/3] RUN make all' },
    { type: 'log', text: '#4 cc -o widget main.c' },
    { type: 'image', image },
  ]);
});

test('it sends progress with the step the build reached while it runs', async () => {
  const done = Promise.withResolvers<Image>();
  const reports: ((step: string) => void)[] = [];

  const events = runImageOp(
    (_signal, report) => {
      reports.push(report.output.setStep);

      return done.promise;
    },
    {
      firstPhase: 'build',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: () => {},
    },
  );

  await events.next();

  const next = events.next();

  const setStep = await waitFor(() => {
    invariant(reports[0]);

    return reports[0];
  });

  setStep('[3/3] RUN make install');

  const second = await next;

  done.resolve(buildMockImage());

  expect(second.value).toStrictEqual({
    type: 'progress',
    phase: 'build',
    elapsedMs: 0,
    step: '[3/3] RUN make install',
  });
});

test('it holds at most 1 MiB of build output for a client that has not read, and counts what it dropped', async () => {
  const image = buildMockImage();

  const events = await Array.fromAsync(
    runImageOp(
      (_signal, report) => {
        for (let line = 0; line < 4096; line += 1) {
          report.output.emitLog('x'.repeat(8000));
        }

        return Promise.resolve(image);
      },
      {
        firstPhase: 'build',
        signal: new AbortController().signal,
        keepaliveMs: 10_000,
        now: () => 0,
        record: () => {},
        logs: true,
      },
    ),
  );

  const kept = events.filter((event) => event.type === 'log' && event.text.startsWith('x'));

  expect(kept).toHaveLength(Math.floor(1024 ** 2 / 8000));

  expect(events.at(-2)).toStrictEqual({
    type: 'log',
    text: `imp: ${String(4096 - kept.length)} lines of build output dropped: the client read them more slowly than the build wrote them`,
  });

  expect(events.at(-1)).toStrictEqual({ type: 'image', image });
});

test('it sends no log events to a client that did not ask for them', async () => {
  const image = buildMockImage();

  const events = await Array.fromAsync(
    runImageOp(
      (_signal, report) => {
        report.output.emitLog('#4 cc -o widget main.c');

        return Promise.resolve(image);
      },
      {
        firstPhase: 'build',
        signal: new AbortController().signal,
        keepaliveMs: 10_000,
        now: () => 0,
        record: () => {},
      },
    ),
  );

  expect(events).toStrictEqual([
    { type: 'progress', phase: 'build', elapsedMs: 0 },
    { type: 'image', image },
  ]);
});

test('it streams the phases of an add, then the image', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  // the image is not on the host: the add pulls it, then unpacks its export
  const docker = createStubDockerCli({
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

  const docker = createStubDockerCli({
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

  const docker = createStubDockerCli({
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

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

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

  const docker = createStubDockerCli({
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

  const docker = createStubDockerCli({
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
  const docker = createStubDockerCli({
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

  const docker = createStubDockerCli({
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
  const docker = createStubDockerCli({
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

  const docker = createStubDockerCli({
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

  const docker = createStubDockerCli({
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
