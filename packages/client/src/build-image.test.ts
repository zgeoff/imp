import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_BUILD_STREAM_TYPE } from '@imp/api';
import type { ImageBuildProgress } from '@imp/api';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import type { ImpdDeps } from '@imp/daemon/src/create-impd';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { BUILD_KEEPALIVE_MS } from '@imp/daemon/src/images/build-event-stream';
import { MOVE_PART_BYTES } from '@imp/daemon/src/moves/move-parts';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { server } from '@imp/test-utils/mock-server';
import { updateEnv } from '@imp/test-utils/update-env';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/client';
import { http } from 'msw';
import { createImpClient } from './create-imp-client';
import { buildStubImpdBeforeBuildStream } from './test-utils/build-stub-impd-before-build-stream';
import { createStubDockerBin } from './test-utils/create-stub-docker-bin';
import { startStubDockerEngine } from './test-utils/start-stub-docker-engine';

// impd on stub VMs and a loopback port, building on the host engine at
// `dockerSocket`, with `keepaliveMs` between a streamed build's progress
// lines; `workDir` holds the test's engine, docker CLI and build contexts
async function setupTest(options: { readonly keepaliveMs?: number } = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root token, the bearer the test's client sends
  const rootToken = 'root-token';

  const dataDir = await mkdtemp(join(tmpdir(), 'imp-client-build-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const workDir = await mkdtemp(join(tmpdir(), 'imp-client-engine-'));

  stack.defer(() => rm(workDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const deps: ImpdDeps = {
    db,
    rootToken,
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so a build never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // a frozen clock, so each progress line's elapsed time is 0
    now: () => Date.UTC(2026, 0, 1),
    keepaliveMs: options.keepaliveMs ?? BUILD_KEEPALIVE_MS,
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

  const dockerSocket = join(workDir, 'docker.sock');

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one; builds
  // run on the host engine, as no builder imp has an agent here
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    IMP_BUILD_ISOLATION: 'host',
    DOCKER_HOST: `unix://${dockerSocket}`,
  });

  const impd = await createImpd(config, deps);

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  // main.ts's body limit, so the build route, not Bun, refuses a large context
  impd.api.app.listen({
    port: 0,
    hostname: '127.0.0.1',
    maxRequestBodySize: Math.max(config.buildContextMaxBytes, MOVE_PART_BYTES) + 1024 ** 2,
  });

  stack.defer(async () => {
    await impd.api.app.stop(true);
  });

  return {
    impd,
    url: `http://127.0.0.1:${String(impd.api.app.server?.port)}/`,
    dockerSocket,
    workDir,
    rootToken,
  };
}

test('it throws PAYLOAD_TOO_LARGE for a context over the limit impd keeps', async () => {
  const ctx = await setupTest();

  const client = createImpClient({ url: ctx.url, token: ctx.rootToken });

  // a stream the caller made, so fetch keeps the declared size; it is over
  // impd's 1 GiB default, so impd refuses the upload unread
  const context = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('tar'));
      controller.close();
    },
  });

  const building = client.buildImage('big', context, { size: 1024 ** 3 + 1 });

  expect(building).rejects.toBeInstanceOf(ORPCError);
  expect(building).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
});

test('it throws BAD_REQUEST for a Dockerfile outside the context', async () => {
  const ctx = await setupTest();

  const client = createImpClient({ url: ctx.url, token: ctx.rootToken });

  expect(
    client.buildImage('web', new Blob(['tar']), { dockerfile: '../Dockerfile' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
});

test('it throws UNAUTHORIZED for a wrong token', async () => {
  const ctx = await setupTest();

  const client = createImpClient({ url: ctx.url, token: 'wrong' });

  expect(client.buildImage('web', new Blob(['tar']))).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    status: 401,
  });
});

test('it uploads a Blob as the build context and answers the image', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;

  const docker = createStubDockerBin(ctx.workDir, {
    'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  const engine = startStubDockerEngine({ socketPath: ctx.dockerSocket, imageId });

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');
  await writeFile(join(ctx.workDir, 'context', 'note'), 'as a blob');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: ctx.url, token: ctx.rootToken });

  const built = await client.buildImage('web', new Blob([tar]));

  const note = Bun.spawnSync(['tar', '-xO', '-f', '-', '--wildcards', '*note'], {
    stdin: engine.contexts.at(0) ?? new Uint8Array(),
  });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: imageId,
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
  });

  expect(note.stdout.toString()).toBe('as a blob');
});

test('it uploads bytes as the build context', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;

  const docker = createStubDockerBin(ctx.workDir, {
    'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  const engine = startStubDockerEngine({ socketPath: ctx.dockerSocket, imageId });

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');
  await writeFile(join(ctx.workDir, 'context', 'note'), 'as bytes');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: ctx.url, token: ctx.rootToken });

  const built = await client.buildImage('web', new Uint8Array(tar));

  const note = Bun.spawnSync(['tar', '-xO', '-f', '-', '--wildcards', '*note'], {
    stdin: engine.contexts.at(0) ?? new Uint8Array(),
  });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: imageId,
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
  });

  expect(note.stdout.toString()).toBe('as bytes');
});

test('it uploads a stream as the build context', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;

  const docker = createStubDockerBin(ctx.workDir, {
    'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  const engine = startStubDockerEngine({ socketPath: ctx.dockerSocket, imageId });

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');
  await writeFile(join(ctx.workDir, 'context', 'note'), 'as a stream');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: ctx.url, token: ctx.rootToken });

  const built = await client.buildImage('web', new Blob([tar]).stream());

  const note = Bun.spawnSync(['tar', '-xO', '-f', '-', '--wildcards', '*note'], {
    stdin: engine.contexts.at(0) ?? new Uint8Array(),
  });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: imageId,
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
  });

  expect(note.stdout.toString()).toBe('as a stream');
});

test('it sends the name, the Dockerfile, the token and what it accepts', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;

  const docker = createStubDockerBin(ctx.workDir, {
    'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);
  startStubDockerEngine({ socketPath: ctx.dockerSocket, imageId });

  await mkdir(join(ctx.workDir, 'context', 'sub'), { recursive: true });
  await writeFile(join(ctx.workDir, 'context', 'sub', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const received = mock<(url: string, headers: Readonly<Record<string, string>>) => void>();

  server.use(
    http.post('http://impd.test/images/build', (info) => {
      received(info.request.url, Object.fromEntries(info.request.headers));

      return ctx.impd.api.app.handle(info.request);
    }),
  );

  const client = createImpClient({ url: 'http://impd.test/', token: ctx.rootToken });

  await client.buildImage('web', new Blob([tar]), { dockerfile: 'sub/Dockerfile' });

  const [call] = received.mock.calls;

  expect(received).toHaveBeenCalledOnce();
  expect(call?.[0]).toBe('http://impd.test/images/build?name=web&dockerfile=sub%2FDockerfile');

  expect(call?.[1]).toContainEntries([
    ['authorization', `Bearer ${ctx.rootToken}`],
    ['content-type', 'application/x-tar'],
    ['accept', `${IMAGE_BUILD_STREAM_TYPE}, application/json`],
  ]);
});

test('it sends the size of a stream as its Content-Length, which impd builds to', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;

  const docker = createStubDockerBin(ctx.workDir, {
    'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  const engine = startStubDockerEngine({ socketPath: ctx.dockerSocket, imageId });

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');
  await writeFile(join(ctx.workDir, 'context', 'note'), 'with its size');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: ctx.url, token: ctx.rootToken });

  // a stream the caller made, in two parts, so fetch keeps the declared size
  const context = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(tar.subarray(0, 512));
      controller.enqueue(tar.subarray(512));
      controller.close();
    },
  });

  const built = await client.buildImage('web', context, { size: tar.byteLength });

  const note = Bun.spawnSync(['tar', '-xO', '-f', '-', '--wildcards', '*note'], {
    stdin: engine.contexts.at(0) ?? new Uint8Array(),
  });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: imageId,
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
  });

  expect(note.stdout.toString()).toBe('with its size');
});

test(
  'it outlasts the idle deadline of a client fetch on progress lines while the engine is silent',
  async () => {
    const ctx = await setupTest({ keepaliveMs: 500 });

    const imageId = `sha256:${'b'.repeat(64)}`;
    const release = Promise.withResolvers<void>();

    onTestFinished(() => {
      release.resolve();
    });

    const docker = createStubDockerBin(ctx.workDir, {
      'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
    });

    updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

    startStubDockerEngine({
      socketPath: ctx.dockerSocket,
      imageId,
      holdUntil: () => release.promise,
    });

    await mkdir(join(ctx.workDir, 'context'));
    await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

    await writeFile(
      join(ctx.workDir, 'context.tar'),
      Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout,
    );

    // the client in a process of its own, as the idle deadline is read at startup
    await writeFile(
      join(ctx.workDir, 'build.ts'),
      [
        `import { createImpClient } from ${JSON.stringify(join(import.meta.dir, 'create-imp-client.ts'))};`,
        'const [url, token, contextPath] = process.argv.slice(2);',
        'const client = createImpClient({ url, token });',
        'const onProgress = (event: unknown) => console.log(JSON.stringify(event));',
        'await client.buildImage("web", Bun.file(contextPath), { onProgress }).then(',
        '  (image) => console.log(JSON.stringify({ type: "image", name: image.name })),',
        '  (error) => console.log(JSON.stringify({ type: "error", name: error.name })),',
        ');',
      ].join('\n'),
    );

    // Bun's fetch gives up after about 8 s with no byte under this setting
    const child = Bun.spawn(
      [
        process.execPath,
        join(ctx.workDir, 'build.ts'),
        ctx.url,
        ctx.rootToken,
        join(ctx.workDir, 'context.tar'),
      ],
      {
        cwd: ctx.workDir,
        env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
        stdout: 'pipe',
      },
    );

    onTestFinished(() => {
      child.kill();
    });

    const output: string[] = [];

    const reading = (async () => {
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        output.push(chunk);
      }
    })();

    // 28 keepalives 0.5 s apart, while the engine says nothing, carry the
    // build past the client's deadline
    await waitFor(
      () => {
        expect(output.join('')).toIncludeRepeated('"phase":"build"', 28);
      },
      { timeoutMs: 20_000, intervalMs: 100 },
    );

    release.resolve();

    await reading;

    const exitCode = await child.exited;

    expect(output.join('').trimEnd().split('\n').at(-1)).toBe('{"type":"image","name":"web"}');
    expect(exitCode).toBe(0);
  },
  { timeout: 30_000 },
);

test(
  'it gives up at the idle deadline of a client fetch on an impd from before the stream, which stops the build',
  async () => {
    const ctx = await setupTest({ keepaliveMs: 500 });

    const imageId = `sha256:${'b'.repeat(64)}`;
    const release = Promise.withResolvers<void>();

    onTestFinished(() => {
      release.resolve();
    });

    const docker = createStubDockerBin(ctx.workDir, {
      'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
    });

    updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

    const engine = startStubDockerEngine({
      socketPath: ctx.dockerSocket,
      imageId,
      holdUntil: () => release.promise,
    });

    await mkdir(join(ctx.workDir, 'context'));
    await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

    await writeFile(
      join(ctx.workDir, 'context.tar'),
      Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout,
    );

    // the client in a process of its own, as the idle deadline is read at
    // startup, through impd from before the stream, which answers JSON at the end
    await writeFile(
      join(ctx.workDir, 'build.ts'),
      [
        `import { createImpClient } from ${JSON.stringify(join(import.meta.dir, 'create-imp-client.ts'))};`,
        `import { buildStubImpdBeforeBuildStream } from ${JSON.stringify(join(import.meta.dir, 'test-utils', 'build-stub-impd-before-build-stream.ts'))};`,
        'const [url, token, contextPath] = process.argv.slice(2);',
        'const client = createImpClient({ url, token, fetch: buildStubImpdBeforeBuildStream(fetch) });',
        'await client.buildImage("web", Bun.file(contextPath)).then(',
        '  (image) => console.log(JSON.stringify({ type: "image", name: image.name })),',
        '  (error) => console.log(JSON.stringify({ type: "error", name: error.name })),',
        ');',
      ].join('\n'),
    );

    // Bun's fetch gives up after about 8 s with no byte under this setting
    const child = Bun.spawn(
      [
        process.execPath,
        join(ctx.workDir, 'build.ts'),
        ctx.url,
        ctx.rootToken,
        join(ctx.workDir, 'context.tar'),
      ],
      {
        cwd: ctx.workDir,
        env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
        stdout: 'pipe',
      },
    );

    onTestFinished(() => {
      child.kill();
    });

    const output = new Response(child.stdout).text();

    await waitFor(() => {
      expect(engine.contexts).toBeArrayOfSize(1);
    });

    const heldAt = Date.now();

    const exitCode = await child.exited;

    const gaveUpAfterMs = Date.now() - heldAt;

    await waitFor(() => {
      expect(engine.signals.at(0)?.aborted).toBeTrue();
    });

    const images = await createImpClient({ url: ctx.url, token: ctx.rootToken }).images.list();
    const said = await output;

    expect(said).toBe('{"type":"error","name":"TimeoutError"}\n');
    expect(exitCode).toBe(0);
    expect(gaveUpAfterMs).toBeWithin(7000, 9000);
    expect(images).toStrictEqual([]);
  },
  { timeout: 30_000 },
);

test('it reports each progress line as it arrives, before the image', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;
  const release = Promise.withResolvers<void>();

  const docker = createStubDockerBin(ctx.workDir, {
    'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  startStubDockerEngine({
    socketPath: ctx.dockerSocket,
    imageId,
    holdUntil: () => release.promise,
  });

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const progress = mock<(event: ImageBuildProgress) => void>();
  const client = createImpClient({ url: ctx.url, token: ctx.rootToken });
  const building = client.buildImage('web', new Blob([tar]), { onProgress: progress });

  await waitFor(() => {
    expect(progress).toHaveBeenLastCalledWith({ type: 'progress', phase: 'build', elapsedMs: 0 });
  });

  const statusWhileBuilding = Bun.peek.status(building);

  release.resolve();

  const built = await building;

  expect(statusWhileBuilding).toBe('pending');

  expect(progress.mock.calls).toStrictEqual([
    [{ type: 'progress', phase: 'upload', elapsedMs: 0 }],
    [{ type: 'progress', phase: 'build', elapsedMs: 0 }],
    [{ type: 'progress', phase: 'unpack', elapsedMs: 0 }],
  ]);

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: imageId,
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
  });
});

test('it throws the ORPCError of the error line that ends the stream', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.workDir, {});

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  startStubDockerEngine({
    socketPath: ctx.dockerSocket,
    imageId: `sha256:${'b'.repeat(64)}`,
    failure: 'the Dockerfile: no such file: note',
  });

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const client = createImpClient({ url: ctx.url, token: ctx.rootToken });
  const building = client.buildImage('web', new Blob([tar]));

  expect(building).rejects.toBeInstanceOf(ORPCError);

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    status: 400,
    message: expect.toInclude('the Dockerfile: no such file: note'),
  });
});

test('it answers the image from an impd that answers JSON, from before the stream', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;

  const docker = createStubDockerBin(ctx.workDir, {
    'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);
  startStubDockerEngine({ socketPath: ctx.dockerSocket, imageId });

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const older = buildStubImpdBeforeBuildStream((request) => ctx.impd.api.app.handle(request));

  server.use(http.all('http://impd.test/*', (info) => older(info.request)));

  const progress = mock<(event: ImageBuildProgress) => void>();
  const client = createImpClient({ url: 'http://impd.test/', token: ctx.rootToken });

  const built = await client.buildImage('web', new Blob([tar]), { onProgress: progress });

  expect(built).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: 'imp/web:latest',
    digest: imageId,
    source: 'oci',
    createdAt: expect.toBeDate(),
    sizeBytes: expect.toBeNumber(),
  });

  expect(progress).not.toHaveBeenCalled();
});

test('it throws the ORPCError that an impd from before the stream answers', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.workDir, {});

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  startStubDockerEngine({
    socketPath: ctx.dockerSocket,
    imageId: `sha256:${'b'.repeat(64)}`,
    failure: 'the Dockerfile: no such file: note',
  });

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\nCOPY note /\n');

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.workDir, 'context'), '-c', '.']).stdout;
  const older = buildStubImpdBeforeBuildStream((request) => ctx.impd.api.app.handle(request));

  server.use(http.all('http://impd.test/*', (info) => older(info.request)));

  const client = createImpClient({ url: 'http://impd.test/', token: ctx.rootToken });
  const building = client.buildImage('web', new Blob([tar]));

  expect(building).rejects.toBeInstanceOf(ORPCError);

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    status: 400,
    message: expect.toInclude('the Dockerfile: no such file: note'),
  });
});
