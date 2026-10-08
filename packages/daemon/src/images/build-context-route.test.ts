import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IMAGE_BUILD_PATH,
  IMAGE_BUILD_STREAM_TYPE,
  ImageBuildEventSchema,
  ImageBuildResultSchema,
} from '@imp/api';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { updateEnv } from '@imp/test-utils/update-env';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createApiAudit } from '../audit/api-audit';
import { toApiImage } from '../build-router';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { listApiCalls } from '../db/api-audit';
import { openDatabase } from '../db/open-database';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { runChecked } from '../process/run-command';
import { createForwardedPeers } from '../proxy/forwarded-peers';
import { startWakeProxy } from '../proxy/wake-proxy';
import {
  buildSystemDrivePath,
  buildSystemDrivesDir,
  buildUploadsDir,
} from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildMockCaller } from '../test-utils/build-mock-caller';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubDockerCli } from '../test-utils/build-stub-docker-cli';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubDockerEngine } from '../test-utils/start-stub-docker-engine';
import { createBuildContextRoute } from './build-context-route';
import { PIN_INSPECT_FORMAT } from './image-pin';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'build-context-route-'));

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

    // a sparse copy for a reflink: the temp dir is not XFS
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
    // a release deferred here runs before impd stops and its database closes
    stack,
    config,
    db,
    dataDir,
    engine,
    impd,
    client,
  };
}

test('it builds an uploaded context and answers the image', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  // the frontend is on the host, and the engine tags what it builds
  const exportTar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout;

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar,
  });

  updateEnv('PATH', docker.path);

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(ImageBuildResultSchema.parse(body).name).toBe('web');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it sends the engine the context under the image tag and the Dockerfile path', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context', 'docker'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'context', 'docker', 'Dockerfile'), 'FROM scratch\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] }],
  });

  updateEnv('PATH', docker.path);

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'docker']).stdout;

  await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web&dockerfile=docker/Dockerfile`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const build = ctx.engine.seen.find((request) => request.target.startsWith('/build'));

  const query = new URL(`http://docker${build?.target ?? ''}`).searchParams;

  expect(query.get('t')).toBe('imp/web:latest');
  expect(query.get('dockerfile')).toBe('docker/Dockerfile');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it removes the upload and audits the build as ok once the build ends', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const exportTar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout;

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar,
  });

  updateEnv('PATH', docker.path);

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.build');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(outcomes).toStrictEqual(['ok']);
  expect(uploads).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it answers a streamed build with its headers while the build still runs', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] }],
  });

  updateEnv('PATH', docker.path);

  // the engine holds the build until the test ends
  const held = Promise.withResolvers<void>();

  // a failed build, once the test lets it go
  ctx.engine.setAnswer(async (_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    await held.promise;

    return new Response(`${JSON.stringify({ error: 'held for the test' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token', accept: IMAGE_BUILD_STREAM_TYPE },
      body: tar,
    }),
  );

  // let go, and read the stream to its end, before the engine stops
  // released before impd stops, so the held builds settle first
  ctx.stack.defer(async () => {
    held.resolve();

    await response.text();
  });

  expect([response.status, response.headers.get('content-type')]).toStrictEqual([
    200,
    IMAGE_BUILD_STREAM_TYPE,
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it streams progress lines while the build runs, then the image', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const exportTar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout;

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar,
  });

  updateEnv('PATH', docker.path);

  // the engine holds the build until the client has read three keepalives
  const gate = Promise.withResolvers<void>();

  ctx.engine.setAnswer(async (_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    await gate.promise;

    return null;
  });

  // a keepalive every 10 ms, so a held build sends lines
  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10,
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { accept: IMAGE_BUILD_STREAM_TYPE },
      body: tar,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  const read = { text: '' };

  while (read.text.split('"phase":"build"').length <= 3) {
    const chunk = await reader?.read();

    read.text += chunk?.value ?? '';
  }

  gate.resolve();

  for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
    read.text += chunk.value;
  }

  const events = read.text
    .trim()
    .split('\n')
    .map((line) => ImageBuildEventSchema.parse(JSON.parse(line)));

  expect(events[0]).toMatchObject({ type: 'progress', phase: 'upload' });
  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'web' } });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// impd on a real socket behind the wake proxy, as a build over HTTPS reaches
// it: the first line comes back while the upload still holds its rest
test('it sends a progress line through the proxy before the upload ends', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const exportTar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout;

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar,
  });

  updateEnv('PATH', docker.path);

  ctx.impd.api.app.listen({ port: 0, hostname: '127.0.0.1' });

  // the listeners close before impd stops and its database and dir go
  ctx.stack.defer(async () => {
    await ctx.impd.api.app.stop(true);
  });

  const apiPort = ctx.impd.api.app.server?.port;

  invariant(apiPort);

  // the proxy forwards the API to the port the app took
  const proxy = startWakeProxy({
    config: { ...ctx.config, apiPort },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  ctx.stack.defer(() => proxy.stop());

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => apex.stop(true));

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;
  const rest = Promise.withResolvers<void>();
  const upload = { ended: false };

  const body = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      controller.enqueue(tar.subarray(0, 512));

      await rest.promise;

      controller.enqueue(tar.subarray(512));

      upload.ended = true;

      controller.close();
    },
  });

  const response = await fetch(
    `http://127.0.0.1:${String(apex.port)}${IMAGE_BUILD_PATH}?name=web`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer root-token', accept: IMAGE_BUILD_STREAM_TYPE },
      body,
      duplex: 'half',
    },
  );

  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();

  const firstChunk = await reader?.read();

  const endedAtFirstLine = upload.ended;

  rest.resolve();

  const parts = [firstChunk?.value ?? ''];

  for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
    parts.push(chunk.value);
  }

  const lines = parts.join('').trim().split('\n');
  const first = ImageBuildEventSchema.parse(JSON.parse(lines[0] ?? 'null'));
  const last = ImageBuildEventSchema.parse(JSON.parse(lines.at(-1) ?? 'null'));

  expect(endedAtFirstLine).toBe(false);
  expect(first).toMatchObject({ type: 'progress', phase: 'upload' });
  expect(last).toMatchObject({ type: 'image', image: { name: 'web' } });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a build to a manage token limited to some imps, and audits it', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'limited',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${made.secret}` },
      body: 'tar',
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.build');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  expect(response.status).toBe(403);
  expect(outcomes).toStrictEqual(['FORBIDDEN']);
  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a build to a read token, and audits it', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${made.secret}` },
      body: 'tar',
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.build');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  expect(response.status).toBe(403);
  expect(outcomes).toStrictEqual(['FORBIDDEN']);
  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it answers 401 to a build with a bearer that is no token', async () => {
  const ctx = await setupTest();

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-token' },
      body: 'tar',
    }),
  );

  expect(response.status).toBe(401);
  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test.each([
  ['name=Bad Name'],
  ['name=web&dockerfile=../Dockerfile'],
  ['name=web&dockerfile=sub/../../Dockerfile'],
  ['name=web&dockerfile=/etc/passwd'],
  [''],
])('it refuses the query %p with 400 before the upload', async (query) => {
  const ctx = await setupTest();

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?${query}`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: 'tar',
    }),
  );

  expect(response.status).toBe(400);
  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses with 413 a context whose Content-Length is over the limit', async () => {
  const ctx = await setupTest();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const response = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { 'content-length': String(2 * 1024 ** 2) },
      body: 'x',
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 413,
    body: {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'the build context is larger than the limit, 1 MiB (IMP_BUILD_CONTEXT_MAX_MIB)',
    },
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it frees the build slot of a context refused for its Content-Length', async () => {
  const ctx = await setupTest();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  // four refusals, one for each build slot
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await route.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
        method: 'POST',
        headers: { 'content-length': String(2 * 1024 ** 2) },
        body: 'x',
      }),
      buildMockCaller(),
      toApiImage,
    );
  }

  const fifth = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { 'content-length': String(2 * 1024 ** 2) },
      body: 'x',
    }),
    buildMockCaller(),
    toApiImage,
  );

  expect(fifth.status).toBe(413);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses with 413 a context whose bytes run over the limit, and removes the upload', async () => {
  const ctx = await setupTest();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  // a body with no Content-Length, one byte over the limit
  const context = new Blob([new Uint8Array(1024 ** 2 + 1)]).stream();

  const response = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      body: context,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();
  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(response.status).toBe(413);

  expect(body).toStrictEqual({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'the build context is larger than the limit, 1 MiB (IMP_BUILD_CONTEXT_MAX_MIB)',
  });

  expect(uploads).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses with 413 a streamed build whose Content-Length is over the limit', async () => {
  const ctx = await setupTest();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const response = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { accept: IMAGE_BUILD_STREAM_TYPE, 'content-length': String(2 * 1024 ** 2) },
      body: 'x',
    }),
    buildMockCaller(),
    toApiImage,
  );

  expect(response.status).toBe(413);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// bytes past the limit come after the stream's 200, so its last line says so
test('it ends a streamed build whose bytes run over the limit with a too-large error', async () => {
  const ctx = await setupTest();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const context = new Blob([new Uint8Array(1024 ** 2 + 1)]).stream();

  const response = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { accept: IMAGE_BUILD_STREAM_TYPE },
      body: context,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const text = await response.text();
  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  const last = ImageBuildEventSchema.parse(JSON.parse(text.trim().split('\n').at(-1) ?? 'null'));

  expect(response.status).toBe(200);

  expect(last).toStrictEqual({
    type: 'error',
    code: 'PAYLOAD_TOO_LARGE',
    message: 'the build context is larger than the limit, 1 MiB (IMP_BUILD_CONTEXT_MAX_MIB)',
  });

  expect(uploads).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// an empty tar, as long as the limit: the build reads it, and finds no Dockerfile
test('it hands a context of exactly the limit to the build', async () => {
  const ctx = await setupTest();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const context = new Blob([new Uint8Array(1024 ** 2)]).stream();

  const response = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      body: context,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'there is no Dockerfile in the build context' },
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a build with no body', async () => {
  const ctx = await setupTest();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const response = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, { method: 'POST' }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'the build context is missing: send a tar' },
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a build whose body is longer than its Content-Length', async () => {
  const ctx = await setupTest();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const context = new Blob([new Uint8Array(64)]).stream();

  const response = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { 'content-length': '4' },
      body: context,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'the body is longer than its Content-Length' },
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a build whose body is empty', async () => {
  const ctx = await setupTest();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const response = await route.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      body: new ReadableStream({
        start: (controller) => {
          controller.close();
        },
      }),
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'the build context is empty: send a tar' },
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a fifth build with 429 while four run', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] }],
  });

  updateEnv('PATH', docker.path);

  // the engine holds every build until the test ends
  const held = Promise.withResolvers<void>();

  // a failed build, once the test lets it go
  ctx.engine.setAnswer(async (_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    await held.promise;

    return new Response(`${JSON.stringify({ error: 'held for the test' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const running = [1, 2, 3, 4].map((n) =>
    ctx.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web${String(n)}`, {
        method: 'POST',
        headers: { authorization: 'Bearer root-token' },
        body: tar,
      }),
    ),
  );

  // let go before the engine stops
  // released before impd stops, so the held builds settle first
  ctx.stack.defer(async () => {
    held.resolve();

    await Promise.allSettled(running);
  });

  await waitFor(() => {
    expect(
      ctx.engine.seen.filter((request) => request.target.startsWith('/build')).length,
    ).toBeGreaterThanOrEqual(4);
  });

  const fifth = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web5`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  expect(fifth.status).toBe(429);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a fifth streamed build with 429, before its stream, while four run', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] }],
  });

  updateEnv('PATH', docker.path);

  const held = Promise.withResolvers<void>();

  // a failed build, once the test lets it go
  ctx.engine.setAnswer(async (_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    await held.promise;

    return new Response(`${JSON.stringify({ error: 'held for the test' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const running = [1, 2, 3, 4].map((n) =>
    ctx.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web${String(n)}`, {
        method: 'POST',
        headers: { authorization: 'Bearer root-token' },
        body: tar,
      }),
    ),
  );

  // let go before the engine stops
  // released before impd stops, so the held builds settle first
  ctx.stack.defer(async () => {
    held.resolve();

    await Promise.allSettled(running);
  });

  await waitFor(() => {
    expect(
      ctx.engine.seen.filter((request) => request.target.startsWith('/build')).length,
    ).toBeGreaterThanOrEqual(4);
  });

  const fifth = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web5`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token', accept: IMAGE_BUILD_STREAM_TYPE },
      body: tar,
    }),
  );

  expect(fifth.status).toBe(429);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it frees each build slot once its build ends', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const exportTar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout;

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: [
          'imp/web1:latest',
          'imp/web2:latest',
          'imp/web3:latest',
          'imp/web4:latest',
          'imp/web5:latest',
        ],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar,
  });

  updateEnv('PATH', docker.path);

  // the engine holds the first four builds until all four have come
  const gate = Promise.withResolvers<void>();

  ctx.engine.setAnswer(async (_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    await gate.promise;

    return null;
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const running = [1, 2, 3, 4].map((n) =>
    ctx.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web${String(n)}`, {
        method: 'POST',
        headers: { authorization: 'Bearer root-token' },
        body: tar,
      }),
    ),
  );

  await waitFor(() => {
    expect(
      ctx.engine.seen.filter((request) => request.target.startsWith('/build')).length,
    ).toBeGreaterThanOrEqual(4);
  });

  gate.resolve();

  const responses = await Promise.all(running);

  const statuses = responses.map((built) => built.status);

  const fifth = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web5`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  expect(statuses).toStrictEqual([200, 200, 200, 200]);
  expect(fifth.status).toBe(200);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test.each([
  ['JSON', {}],
  ['a stream', { accept: IMAGE_BUILD_STREAM_TYPE }],
])(
  'it stops the engine build of a client that goes, answered as %s, and removes its upload',
  async (_, headers) => {
    const ctx = await setupTest();

    await mkdir(join(ctx.dataDir, 'context'));
    await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');

    const docker = buildStubDockerCli({
      dir: ctx.dataDir,
      images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] }],
    });

    updateEnv('PATH', docker.path);

    // the engine holds each build until its client goes
    const builds = { started: 0, stopped: 0 };

    ctx.engine.setAnswer(async (request, seen) => {
      if (!seen.target.startsWith('/build')) {
        return null;
      }

      builds.started += 1;

      await new Promise((resolve) => {
        request.signal.addEventListener('abort', resolve);
      });

      builds.stopped += 1;

      return new Response(null, { status: 499 });
    });

    const tar = Bun.spawnSync([
      'tar',
      '-C',
      join(ctx.dataDir, 'context'),
      '-c',
      'Dockerfile',
    ]).stdout;

    const clients = [1, 2, 3, 4].map(() => new AbortController());

    const sent = clients.map((client, n) =>
      ctx.impd.api.app.handle(
        new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=gone${String(n)}`, {
          method: 'POST',
          headers: { authorization: 'Bearer root-token', ...headers },
          body: tar,
          signal: client.signal,
        }),
      ),
    );

    await waitFor(() => {
      expect(builds.started).toBeGreaterThanOrEqual(4);
    });

    for (const client of clients) {
      client.abort();
    }

    await Promise.allSettled(sent);

    // a stream answered before its build ended: the build's audit row comes
    // after its file is gone; the engine hears each close in its own time
    const stopped = await waitFor(async () => {
      const rows = await listApiCalls(ctx.db, null, 100, null);

      expect(rows.filter((row) => row.procedure === 'images.build').length).toBeGreaterThanOrEqual(
        4,
      );

      expect(builds.stopped).toBeGreaterThanOrEqual(4);

      return builds.stopped;
    });

    const uploads = await readdir(buildUploadsDir(ctx.dataDir));

    expect(stopped).toBe(4);
    expect(uploads).toStrictEqual([]);
    expect(ctx.engine.unexpected).toStrictEqual([]);
  },
);

test.each([
  ['JSON', {}],
  ['a stream', { accept: IMAGE_BUILD_STREAM_TYPE }],
])('it frees the build slot of a client that goes, answered as %s', async (_, headers) => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] }],
  });

  updateEnv('PATH', docker.path);

  const builds = { started: 0 };

  ctx.engine.setAnswer(async (request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    builds.started += 1;

    await new Promise((resolve) => {
      request.signal.addEventListener('abort', resolve);
    });

    return new Response(null, { status: 499 });
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;
  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, n) =>
    ctx.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=gone${String(n)}`, {
        method: 'POST',
        headers: { authorization: 'Bearer root-token', ...headers },
        body: tar,
        signal: client.signal,
      }),
    ),
  );

  await waitFor(() => {
    expect(builds.started).toBeGreaterThanOrEqual(4);
  });

  for (const client of clients) {
    client.abort();
  }

  await Promise.allSettled(sent);

  await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    expect(rows.filter((row) => row.procedure === 'images.build').length).toBeGreaterThanOrEqual(4);
  });

  // not a tar: refused by the build, not for want of a slot
  const next = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: 'not a tar',
    }),
  );

  expect(next.status).toBe(400);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it kills the base image pulls of clients that go, and starts no other pull', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'FROM first.test/a:1\nFROM second.test/b:1\n',
  );

  // neither image is on the host, and a pull hangs until it is killed
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['first.test/a:1'],
        inspects: [{ Id: `sha256:${'a'.repeat(64)}` }],
        isOnHost: false,
        pull: 'hang',
      },
      {
        refs: ['second.test/b:1'],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}` }],
        isOnHost: false,
        pull: 'hang',
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;
  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, n) =>
    ctx.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=pull${String(n)}`, {
        method: 'POST',
        headers: { authorization: 'Bearer root-token' },
        body: tar,
        signal: client.signal,
      }),
    ),
  );

  await waitFor(() => {
    expect(
      docker.readCalls().filter((call) => call.startsWith('pull')).length,
    ).toBeGreaterThanOrEqual(4);
  });

  for (const client of clients) {
    client.abort();
  }

  // the pulls sleep 30 s: only their kill settles the builds within the wait
  await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    expect(rows.filter((row) => row.procedure === 'images.build').length).toBeGreaterThanOrEqual(4);
  });

  await Promise.allSettled(sent);

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(docker.readCalls().filter((call) => call.startsWith('pull'))).toStrictEqual([
    'pull --quiet first.test/a:1',
    'pull --quiet first.test/a:1',
    'pull --quiet first.test/a:1',
    'pull --quiet first.test/a:1',
  ]);

  expect(uploads).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it frees the build slots of clients that go during a base image pull', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM first.test/a:1\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['first.test/a:1'],
        inspects: [{ Id: `sha256:${'a'.repeat(64)}` }],
        isOnHost: false,
        pull: 'hang',
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;
  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, n) =>
    ctx.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=pull${String(n)}`, {
        method: 'POST',
        headers: { authorization: 'Bearer root-token' },
        body: tar,
        signal: client.signal,
      }),
    ),
  );

  await waitFor(() => {
    expect(
      docker.readCalls().filter((call) => call.startsWith('pull')).length,
    ).toBeGreaterThanOrEqual(4);
  });

  for (const client of clients) {
    client.abort();
  }

  await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    expect(rows.filter((row) => row.procedure === 'images.build').length).toBeGreaterThanOrEqual(4);
  });

  await Promise.allSettled(sent);

  // not a tar: refused by the build, not for want of a slot
  const next = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: 'not a tar',
    }),
  );

  expect(next.status).toBe(400);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a base image with ONBUILD triggers once the host has it', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'FROM base.test/onbuild:1\nRUN true\n',
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/onbuild:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/onbuild@sha256:${'a'.repeat(64)}`],
            Config: { OnBuild: ['RUN id'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(response.status).toBe(400);

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'FROM base.test/onbuild:1 has ONBUILD triggers, which impd refuses',
  });

  expect(calls).toStrictEqual([
    'version --format {{json .Server.Os}} {{json .Server.Arch}}',
    'image inspect --format PIN base.test/onbuild:1',
  ]);

  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it pulls COPY --from and RUN --mount images first, like a FROM, by tag or digest', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    `FROM base.test/a:1 AS build\nCOPY --from=tools.test/b@sha256:${'b'.repeat(64)} /x /x\nCOPY --from=build /x /y\nRUN --mount=type=bind,from=mnt.test/c:3,target=/m true`,
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/a:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [
              `other.test/x@sha256:${'b'.repeat(64)}`,
              `base.test/a@sha256:${'a'.repeat(64)}`,
            ],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      {
        refs: [`tools.test/b@sha256:${'b'.repeat(64)}`],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`tools.test/b@sha256:${'b'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
        isOnHost: false,
      },
      {
        refs: ['mnt.test/c:3'],
        inspects: [
          { Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [], Config: { Env: ['PATH=/bin'] } },
        ],
        isOnHost: false,
        pull: { stderr: 'no such registry' },
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'RUN --mount from mnt.test/c:3: the pull failed: no such registry',
  });

  expect(calls).toStrictEqual([
    'version --format {{json .Server.Os}} {{json .Server.Arch}}',
    'image inspect --format PIN base.test/a:1',
    `image inspect --format PIN tools.test/b@sha256:${'b'.repeat(64)}`,
    `pull --quiet tools.test/b@sha256:${'b'.repeat(64)}`,
    `image inspect --format PIN tools.test/b@sha256:${'b'.repeat(64)}`,
    'image inspect --format PIN mnt.test/c:3',
    'pull --quiet mnt.test/c:3',
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it sends the engine the Dockerfile with each image pinned and the platform named', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'FROM --platform=$BUILDPLATFORM base.test/a:1 AS build\nCOPY --from=pulled.test/p:2 /x /x\nFROM base.test/retag:1\nRUN --mount=from=build,target=/b --mount=from=base.test/a:1,target=/a true\n',
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/a:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [
              `other.test/x@sha256:${'b'.repeat(64)}`,
              `base.test/a@sha256:${'a'.repeat(64)}`,
            ],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      {
        refs: ['pulled.test/p:2'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`tools.test/b@sha256:${'b'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
        isOnHost: false,
      },
      {
        refs: ['base.test/retag:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`other.test/x@sha256:${'b'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'docker build failed: the stub engine builds nothing',
  });

  expect(built).toStrictEqual([
    [
      `FROM --platform=linux/amd64 base.test/a@sha256:${'a'.repeat(64)} AS build`,
      `COPY --from=tools.test/b@sha256:${'b'.repeat(64)} /x /x`,
      `FROM other.test/x@sha256:${'b'.repeat(64)}`,
      `RUN --mount=from=build,target=/b --mount=from=base.test/a@sha256:${'a'.repeat(64)},target=/a true`,
      '',
    ].join('\n'),
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a COPY --from image with ONBUILD triggers, which the frontend would run', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'FROM scratch\nCOPY --from=base.test/onbuild:1 / /\n',
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/onbuild:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/onbuild@sha256:${'a'.repeat(64)}`],
            Config: { OnBuild: ['RUN id'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'COPY --from base.test/onbuild:1 has ONBUILD triggers, which impd refuses',
  });

  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a RUN --mount image with ONBUILD triggers, which the frontend would run', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'FROM base.test/a:1\nRUN --mount=from=base.test/onbuild:1,target=/m true\n',
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/a:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [
              `other.test/x@sha256:${'b'.repeat(64)}`,
              `base.test/a@sha256:${'a'.repeat(64)}`,
            ],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      {
        refs: ['base.test/onbuild:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/onbuild@sha256:${'a'.repeat(64)}`],
            Config: { OnBuild: ['RUN id'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'RUN --mount from base.test/onbuild:1 has ONBUILD triggers, which impd refuses',
  });

  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it inspects and pins a ref the build names twice once, so a moving tag gives one image', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'FROM base.test/moving:1\nCOPY --from=base.test/moving:1 /x /x\nRUN --mount=from=base.test/moving:1,target=/m true\n',
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/moving:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/moving@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/moving@sha256:${'b'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(calls.filter((call) => call.startsWith('image inspect --format PIN'))).toStrictEqual([
    'image inspect --format PIN base.test/moving:1',
  ]);

  expect(built).toStrictEqual([
    [
      `FROM base.test/moving@sha256:${'a'.repeat(64)}`,
      `COPY --from=base.test/moving@sha256:${'a'.repeat(64)} /x /x`,
      `RUN --mount=from=base.test/moving@sha256:${'a'.repeat(64)},target=/m true`,
      '',
    ].join('\n'),
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it inspects and pins the spellings of one image once', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'FROM moving:1\nCOPY --from=docker.io/library/moving:1 /x /x\nRUN --mount=from=index.docker.io/library/moving,target=/m true\n',
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['moving:1', 'docker.io/library/moving:1', 'index.docker.io/library/moving'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`moving@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`moving@sha256:${'b'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  // moving and moving:1 differ: no tag is latest
  expect(calls.filter((call) => call.startsWith('image inspect --format PIN'))).toStrictEqual([
    'image inspect --format PIN moving:1',
    'image inspect --format PIN index.docker.io/library/moving',
  ]);

  expect(built).toStrictEqual([
    [
      `FROM moving@sha256:${'a'.repeat(64)}`,
      `COPY --from=moving@sha256:${'a'.repeat(64)} /x /x`,
      `RUN --mount=from=moving@sha256:${'b'.repeat(64)},target=/m true`,
      '',
    ].join('\n'),
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it says how impd pinned a build the registry denies, and what to build from', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM base.test/retag:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/retag:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`other.test/x@sha256:${'b'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(
      `${JSON.stringify({ error: 'pull access denied, repository does not exist or may require authorization' })}\n`,
    );
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: `docker build failed: pull access denied, repository does not exist or may require authorization\nimpd pinned FROM base.test/retag:1 as other.test/x@sha256:${'b'.repeat(64)}. On the containerd image store a retag of a multi-platform image cannot be pinned: build FROM its original repository, such as busybox:1.37, instead of the retag.`,
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a FROM image with no registry digest before the build', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM base.test/local:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/local:1'],
        inspects: [
          { Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [], Config: { Env: ['PATH=/bin'] } },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message:
      'FROM base.test/local:1: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; build FROM a registry image by tag or digest. Local base images are not supported yet (#156).',
  });

  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a COPY --from image with no registry digest before the build', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'FROM scratch\nCOPY --from=base.test/local:1 / /\n',
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/local:1'],
        inspects: [
          { Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [], Config: { Env: ['PATH=/bin'] } },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message:
      'COPY --from base.test/local:1: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; name a registry image by tag or digest. Local base images are not supported yet (#156).',
  });

  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses an arm64 image on an amd64 host before the build', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM base.test/arm:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/arm:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/arm@sha256:${'a'.repeat(64)}`],
            Architecture: 'aarch64',
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message:
      'FROM base.test/arm:1: the host has this image for linux/arm64, and builds for linux/amd64',
  });

  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a 32-bit arm image on an amd64 host before the build', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM base.test/arm32:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/arm32:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/arm32@sha256:${'a'.repeat(64)}`],
            Architecture: 'arm',
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message:
      'FROM base.test/arm32:1: the host has this image for linux/arm, and builds for linux/amd64',
  });

  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses an image whose registry digests name only registries impd refuses', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM base.test/private:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/private:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [
              `localhost:5000/x@sha256:${'a'.repeat(64)}`,
              `10.0.0.5:5000/y@sha256:${'b'.repeat(64)}`,
            ],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: `FROM base.test/private:1: its registry digests name only registries impd refuses: localhost:5000/x@sha256:${'a'.repeat(64)}, 10.0.0.5:5000/y@sha256:${'b'.repeat(64)}`,
  });

  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// with the image on the host already, no pull would meet the proxy's rule
test('it refuses an image under an IP address registry before any call', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM 127.0.0.1:5000/x:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['LocalHost/name:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`LocalHost/name@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'FROM 127.0.0.1:5000/x:1: registry 127.0.0.1:5000 is an IP address',
  });

  expect(calls).toStrictEqual(['version --format {{json .Server.Os}} {{json .Server.Arch}}']);
  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// docker reads the label as localhost in any case
test("it refuses an image under the host's own registry, in any case, before any call", async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM LocalHost/name:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['LocalHost/name:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`LocalHost/name@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: "FROM LocalHost/name:1: registry LocalHost is the host's own",
  });

  expect(calls).toStrictEqual(['version --format {{json .Server.Os}} {{json .Server.Arch}}']);
  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a global ARG that sets the build platform before any call', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'ARG BUILDPLATFORM=linux/arm64\nFROM --platform=$BUILDPLATFORM base.test/a:1\n',
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/a:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('line 1: ARG BUILDPLATFORM is refused') as unknown,
  });

  expect(calls).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a stage ARG that sets the target platform before any call', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    'FROM base.test/a:1\nARG TARGETPLATFORM\n',
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/a:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('line 2: ARG TARGETPLATFORM is refused') as unknown,
  });

  expect(calls).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a braced platform variable before any call', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));

  await writeFile(
    join(ctx.dataDir, 'context', 'Dockerfile'),
    ['FROM --platform=$', '{BUILDPLATFORM} base.test/a:1\n'].join(''),
  );

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/a:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: expect.stringContaining(
      ['FROM --platform=$', '{BUILDPLATFORM} is refused'].join(''),
    ) as unknown,
  });

  expect(calls).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it pulls a missing Dockerfile frontend by digest once, before the build', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM base.test/a:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/a:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      {
        refs: [DOCKERFILE_FRONTEND],
        inspects: [{ Id: `sha256:${'f'.repeat(64)}` }],
        isOnHost: false,
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const callsAtBuild: string[][] = [];

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    callsAtBuild.push(docker.readCalls());

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  expect(callsAtBuild.map((each) => each.slice(-2))).toStrictEqual([
    [
      `image inspect --format {{.Id}} ${DOCKERFILE_FRONTEND}`,
      `pull --quiet ${DOCKERFILE_FRONTEND}`,
    ],
  ]);

  expect(calls.filter((call) => call.includes('docker/dockerfile'))).toStrictEqual([
    `image inspect --format {{.Id}} ${DOCKERFILE_FRONTEND}`,
    `pull --quiet ${DOCKERFILE_FRONTEND}`,
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it pulls no Dockerfile frontend the engine has, and checks it before the build', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM base.test/a:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/a:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
    ],
  });

  updateEnv('PATH', docker.path);

  const callsAtBuild: string[][] = [];

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    callsAtBuild.push(docker.readCalls());

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const calls = docker.readCalls().map((call) => call.replace(PIN_INSPECT_FORMAT, 'PIN'));

  expect(
    callsAtBuild.map((each) => each.filter((call) => call.includes('docker/dockerfile'))),
  ).toStrictEqual([[`image inspect --format {{.Id}} ${DOCKERFILE_FRONTEND}`]]);

  expect(calls.filter((call) => call.startsWith('pull'))).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it fails a build with 502 before the engine gets it when the frontend pull fails', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM base.test/a:1\n');

  // an amd64 host engine with these images
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['base.test/a:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
            Config: { Env: ['PATH=/bin'] },
          },
        ],
      },
      {
        refs: [DOCKERFILE_FRONTEND],
        inspects: [{ Id: `sha256:${'f'.repeat(64)}` }],
        isOnHost: false,
        pull: { stderr: 'no route to host' },
      },
    ],
  });

  updateEnv('PATH', docker.path);

  // the engine fails every build, after it has the context
  ctx.engine.setAnswer((_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    return new Response(`${JSON.stringify({ error: 'the stub engine builds nothing' })}\n`);
  });

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  // the Dockerfile in each context the engine got
  const built = ctx.engine.seen
    .filter((request) => request.target.startsWith('/build'))
    .map((request) => {
      const extracted = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], {
        stdin: request.body,
      });

      return new TextDecoder().decode(extracted.stdout);
    });

  expect(response.status).toBe(502);

  expect(body).toStrictEqual({
    code: 'BAD_GATEWAY',
    message: `the Dockerfile frontend ${DOCKERFILE_FRONTEND}: the pull failed: no route to host`,
  });

  expect(built).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it answers a build that fails after the engine built it with its error, and removes the upload', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  // the engine builds the image; the unpack's create finds no room
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { stderr: 'no space left on device' },
  });

  updateEnv('PATH', docker.path);

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const body: unknown = await response.json();
  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(response.status).toBe(500);

  expect(body).toStrictEqual({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'docker create imp/web:latest /bin/true exited 1: no space left on device',
  });

  expect(uploads).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it ends a streamed build that fails with its error, and removes the upload', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { stderr: 'no space left on device' },
  });

  updateEnv('PATH', docker.path);

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token', accept: IMAGE_BUILD_STREAM_TYPE },
      body: tar,
    }),
  );

  const text = await response.text();

  const last = ImageBuildEventSchema.parse(JSON.parse(text.trim().split('\n').at(-1) ?? 'null'));

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(last).toStrictEqual({
    type: 'error',
    code: 'INTERNAL_SERVER_ERROR',
    message: 'docker create imp/web:latest /bin/true exited 1: no space left on device',
  });

  expect(uploads).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it audits a failed build with its code', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { stderr: 'no space left on device' },
  });

  updateEnv('PATH', docker.path);

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'context'), '-c', 'Dockerfile']).stdout;

  await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: tar,
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.build');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  expect(outcomes).toStrictEqual(['INTERNAL_SERVER_ERROR']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it clears what an earlier impd left in the uploads directory when a route starts', async () => {
  const ctx = await setupTest();

  const leftover = join(buildUploadsDir(ctx.dataDir), 'old.tar');

  await writeFile(leftover, 'half a context');

  createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: ctx.impd.images,
    diskBudget: ctx.impd.diskBudget,
    audit: createApiAudit({ db: ctx.db, now: Date.now, log: () => {} }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  expect(existsSync(leftover)).toBeFalse();
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it reports the unpack of an on-host build after the engine built the image', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  // the frontend and the built tag are on the host; the unpack's create fails
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 1 }],
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const phases: string[] = [];

  const building = ctx.impd.images.buildImage(join(ctx.dataDir, 'context'), 'web', undefined, {
    setPhase: (phase) => {
      phases.push(phase);
    },
  });

  expect(building).rejects.toThrow('stub docker: create imp/web:latest /bin/true is not modelled');
  expect(phases).toStrictEqual(['build', 'unpack']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses an on-host build at once while uploads hold all four build slots', async () => {
  const ctx = await setupTest();

  const held = [1, 2, 3, 4].map(() => ctx.impd.images.claimBuildSlot());

  onTestFinished(() => {
    for (const release of held) {
      release();
    }
  });

  const building = ctx.impd.images.buildImage('relative/path', 'web');

  expect(building).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses an upload with 429 while on-host builds hold all four build slots', async () => {
  const ctx = await setupTest();

  const held = [1, 2, 3, 4].map(() => ctx.impd.images.claimBuildSlot());

  onTestFinished(() => {
    for (const release of held) {
      release();
    }
  });

  const response = await ctx.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer root-token' },
      body: 'tar',
    }),
  );

  expect(response.status).toBe(429);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it lets an on-host build through to its own checks once a build slot is free', async () => {
  const ctx = await setupTest();

  const held = [1, 2, 3, 4].map(() => ctx.impd.images.claimBuildSlot());

  onTestFinished(() => {
    for (const release of held.slice(1)) {
      release();
    }
  });

  held[0]?.();
  const building = ctx.impd.images.buildImage('relative/path', 'web');

  expect(building).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});
