import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import type { ImpdDeps } from '@imp/daemon/src/create-impd';
import { createImage } from '@imp/daemon/src/db/images';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { server } from '@imp/test-utils/mock-server';
import { updateEnv } from '@imp/test-utils/update-env';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/client';
import { HttpResponse, http } from 'msw';
import { CLIENT_VERSION } from './check-server';
import { createImpClient } from './create-imp-client';
import { createStubDockerBin } from './test-utils/create-stub-docker-bin';
import { startStubDockerEngine } from './test-utils/start-stub-docker-engine';

// impd's dependencies on stub VMs; `startImpd` boots one over the same
// database and storage, as a restart does, and serves it at http://impd.test/
// through the run's MSW server; `workDir` holds a test's host engine
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root token, the bearer the test's client sends
  const rootToken = 'root-token';

  const dataDir = await mkdtemp(join(tmpdir(), 'imp-client-'));

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

  // the image every imps.create boots when it names none
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const vmm = buildStubVmm();

  const deps: Omit<ImpdDeps, 'vms'> = {
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

    // the host's free space, so a create never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},
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

  const client = createImpClient({ url: 'http://impd.test/', token: rootToken });

  // each impd binds its own resolver port and takes a new runner; the stub
  // VMM runs no jailer and builds no boot template
  const startImpd = async (env: Readonly<Record<string, string>> = {}) => {
    const config = loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
      ...env,
    });

    const impd = await createImpd(config, { ...deps, vms: vmm.startGeneration() });

    stack.defer(() => impd.broker.stop());

    stack.defer(() => {
      impd.egress.stop();
      impd.diskUsage.stop();
    });

    server.use(http.all('http://impd.test/*', (info) => impd.api.app.handle(info.request)));

    return impd;
  };

  return { vmm, client, startImpd, workDir, rootToken };
}

test('#createImpClient calls the contract under the base url with the bearer token', async () => {
  const ctx = await setupTest();
  const impd = await ctx.startImpd();

  const paths = mock<(path: string) => void>();

  server.use(
    http.all('http://impd.test/*', (info) => {
      paths(new URL(info.request.url).pathname);

      return impd.api.app.handle(info.request);
    }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  const listed = await ctx.client.imps.list();

  expect(listed).toMatchObject([{ name: 'dev', state: 'running' }]);
  expect(paths.mock.calls).toStrictEqual([['/rpc/imps/create'], ['/rpc/imps/list']]);
});

test('#createImpClient rejects a call with a wrong token as UNAUTHORIZED', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();

  const client = createImpClient({ url: 'http://impd.test/', token: 'wrong' });

  expect(client.system.info()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});

test('#requireAwake wakes a sleeping imp', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();
  await ctx.client.imps.create({ name: 'asleep' });
  await ctx.client.imps.sleep({ name: 'asleep' });

  const woken = await ctx.client.requireAwake('asleep');

  expect(woken.state).toBe('running');
});

test('#requireAwake boots a stopped imp', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();
  await ctx.client.imps.create({ name: 'off' });
  await ctx.client.imps.stop({ name: 'off' });

  const booted = await ctx.client.requireAwake('off');

  expect(booted.state).toBe('running');
});

test('#requireAwake answers a running imp as it is', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();
  await ctx.client.imps.create({ name: 'dev' });

  const awake = await ctx.client.requireAwake('dev');

  expect(awake.state).toBe('running');
});

test('#requireAwake refuses an imp in error with INVALID_STATE', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();

  ctx.vmm.queue('boot', 'fail');

  await ctx.client.imps.create({ name: 'dev' }).catch(() => null);

  expect(ctx.client.requireAwake('dev')).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'error' },
  });
});

test('#requireAwake restarts an imp in error when told to', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();

  ctx.vmm.queue('boot', 'fail');

  await ctx.client.imps.create({ name: 'dev' }).catch(() => null);

  const restarted = await ctx.client.requireAwake('dev', { restartError: true });

  expect(restarted.state).toBe('running');
});

test('#requireAwake passes RAM_BUDGET_EXCEEDED on after one wake', async () => {
  const ctx = await setupTest();

  const impd = await ctx.startImpd({
    IMP_RAM_BUDGET_MIB: '600',
    IMP_DEFAULT_MEMORY_MIB: '512',
    IMP_BOOT_RESERVE_PERCENT: '100',
  });

  await ctx.client.imps.create({ name: 'a' });
  await ctx.client.imps.stop({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });

  const paths = mock<(path: string) => void>();

  server.use(
    http.all('http://impd.test/*', (info) => {
      paths(new URL(info.request.url).pathname);

      return impd.api.app.handle(info.request);
    }),
  );

  const waking = ctx.client.requireAwake('a', { retryUnavailable: { attempts: 3, delayMs: 1 } });

  expect(waking).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { budgetMib: 600, requestedMib: 512 },
  });

  expect(paths).toHaveBeenCalledExactlyOnceWith('/rpc/imps/wake');
});

test('#requireAwake rejects with SERVICE_UNAVAILABLE while impd stops', async () => {
  const ctx = await setupTest();
  const impd = await ctx.startImpd();

  await ctx.client.imps.create({ name: 'dev' });
  await impd.imps.sleepAllImps();

  expect(ctx.client.requireAwake('dev')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
});

test('#requireAwake waits out a stopping impd for the one that replaces it when asked to', async () => {
  const ctx = await setupTest();
  const stopping = await ctx.startImpd();

  await ctx.client.imps.create({ name: 'dev' });
  await stopping.imps.sleepAllImps();

  const replacement = await ctx.startImpd();

  const wakes = mock<(impd: string, status: number) => void>();

  // the first wake still reaches the impd that stops, and the next the one that replaces it
  server.use(
    http.post(
      'http://impd.test/rpc/imps/wake',
      async (info) => {
        const answer = await stopping.api.app.handle(info.request);

        wakes('stopping', answer.status);

        return answer;
      },
      { once: true },
    ),
    http.post('http://impd.test/rpc/imps/wake', async (info) => {
      const answer = await replacement.api.app.handle(info.request);

      wakes('replacement', answer.status);

      return answer;
    }),
  );

  const imp = await ctx.client.requireAwake('dev', {
    retryUnavailable: { attempts: 2, delayMs: 1 },
  });

  expect(imp.state).toBe('running');

  expect(wakes.mock.calls).toStrictEqual([
    ['stopping', 503],
    ['replacement', 200],
  ]);
});

test('#requireAwake rejects with the TypeError of an impd it cannot reach', () => {
  // nothing listens on a free port
  const client = createImpClient({
    url: `http://127.0.0.1:${String(findFreePorts(1).take())}/`,
    token: 'root-token',
  });

  expect(client.requireAwake('dev')).rejects.toBeInstanceOf(TypeError);
});

test('#requireAwake retries an impd it cannot reach when asked to', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  server.use(
    http.post('http://impd.test/rpc/imps/wake', () => HttpResponse.error(), { once: true }),
    http.post('http://impd.test/rpc/imps/wake', () => HttpResponse.error(), { once: true }),
  );

  const imp = await ctx.client.requireAwake('dev', {
    retryUnavailable: { attempts: 2, delayMs: 1 },
  });

  expect(imp.state).toBe('running');
});

test('#requireAwake rejects with the abort reason when aborted while it waits to retry', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const wakes = mock<() => void>();

  const abort = new AbortController();
  const reason = new Error('gave up');

  server.use(
    http.post('http://impd.test/rpc/imps/wake', () => {
      wakes();

      return HttpResponse.error();
    }),
  );

  const waking = ctx.client.requireAwake('dev', {
    retryUnavailable: { attempts: 3, delayMs: 60_000 },
    signal: abort.signal,
  });

  await waitFor(() => {
    expect(wakes).toHaveBeenCalledOnce();
  });

  abort.abort(reason);

  expect(waking).rejects.toBe(reason);
  expect(wakes).toHaveBeenCalledOnce();
});

test('#requireAwake rejects with the reason of a signal that already aborted', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();
  await ctx.client.imps.create({ name: 'dev' });

  const reason = new Error('gave up');

  expect(ctx.client.requireAwake('dev', { signal: AbortSignal.abort(reason) })).rejects.toBe(
    reason,
  );
});

test('#checkServer reports both versions and that they are compatible', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();

  const check = await ctx.client.checkServer();

  expect(check).toStrictEqual({
    clientVersion: CLIENT_VERSION,
    serverVersion: CLIENT_VERSION,
    compatible: true,
  });
});

test('#images.addStream hands on each progress event, then the image', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'c'.repeat(64)}`;

  const docker = createStubDockerBin(ctx.workDir, {
    'busybox:1.37': {
      id: imageId,
      repoDigests: [`busybox@sha256:${'d'.repeat(64)}`],
      files: { hello: 'from busybox\n' },
    },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  // adds pull onto the host engine, as no builder imp has an agent here
  await ctx.startImpd({ IMP_BUILD_ISOLATION: 'host' });

  const events = await ctx.client.images.addStream({ ref: 'busybox:1.37', name: 'box' });
  const received = await Array.fromAsync(events);

  expect(received).toStrictEqual([
    { type: 'progress', phase: 'pull', elapsedMs: expect.toBeNumber() },
    { type: 'progress', phase: 'unpack', elapsedMs: expect.toBeNumber() },
    {
      type: 'image',
      image: {
        id: expect.toBeString(),
        name: 'box',
        ref: 'busybox:1.37',
        digest: imageId,
        source: 'oci',
        createdAt: expect.toBeDate(),
        sizeBytes: expect.toBeNumber(),
      },
    },
  ]);
});

test('#images.addStream throws the ORPCError of an add that impd refuses', async () => {
  const ctx = await setupTest();

  // adds pull onto the host engine, as no builder imp has an agent here
  await ctx.startImpd({ IMP_BUILD_ISOLATION: 'host' });

  const events = await ctx.client.images.addStream({ ref: 'busybox:1.37', name: 'imp-builder' });

  const reading = Array.fromAsync(events);

  expect(reading).rejects.toBeInstanceOf(ORPCError);

  expect(reading).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.toInclude("the image name imp-builder is impd's"),
  });
});

test('#images.buildStream hands on each progress event as it comes, then the image', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;
  const release = Promise.withResolvers<void>();

  const docker = createStubDockerBin(ctx.workDir, {
    'imp/web:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  startStubDockerEngine({
    socketPath: join(ctx.workDir, 'docker.sock'),
    imageId,
    holdUntil: () => release.promise,
  });

  // builds run on the host engine, as no builder imp has an agent here
  await ctx.startImpd({
    IMP_BUILD_ISOLATION: 'host',
    DOCKER_HOST: `unix://${join(ctx.workDir, 'docker.sock')}`,
  });

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const events = await ctx.client.images.buildStream({
    contextDir: join(ctx.workDir, 'context'),
    name: 'web',
  });

  const received: unknown[] = [];

  const reading = (async () => {
    for await (const event of events) {
      received.push(event);
    }
  })();

  await waitFor(() => {
    expect(received).toPartiallyContain({ type: 'progress', phase: 'build' });
  });

  const statusWhileBuilding = Bun.peek.status(reading);

  release.resolve();

  await reading;

  expect(statusWhileBuilding).toBe('pending');

  expect(received).toStrictEqual([
    { type: 'progress', phase: 'pack', elapsedMs: expect.toBeNumber() },
    { type: 'progress', phase: 'build', elapsedMs: expect.toBeNumber() },
    { type: 'progress', phase: 'unpack', elapsedMs: expect.toBeNumber() },
    {
      type: 'image',
      image: {
        id: expect.toBeString(),
        name: 'web',
        ref: 'imp/web:latest',
        digest: imageId,
        source: 'oci',
        createdAt: expect.toBeDate(),
        sizeBytes: expect.toBeNumber(),
      },
    },
  ]);
});
