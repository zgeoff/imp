import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { updateEnv } from '@imp/test-utils/update-env';
import { createStubDockerBin } from '../../../packages/client/src/test-utils/create-stub-docker-bin';
import { startStubDockerEngine } from '../../../packages/client/src/test-utils/start-stub-docker-engine';
import { loadConfig } from '../../../packages/daemon/src/config';
import { createImpd } from '../../../packages/daemon/src/create-impd';
import { openDatabase } from '../../../packages/daemon/src/db/open-database';
import { MOVE_PART_BYTES } from '../../../packages/daemon/src/moves/move-parts';
import {
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../../../packages/daemon/src/storage/data-layout';
import { createXfsBackend } from '../../../packages/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '../../../packages/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../../../packages/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '../../../packages/daemon/src/test-utils/find-free-ports';
import { sendRawBuild, writeBuildContext } from './build-context';

// impd's real app on the stub VMM and a loopback port, building on the host
// engine at `dockerSocket`; `root` holds the test's contexts, engine and
// docker CLI
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const root = await mkdtemp(join(tmpdir(), 'build-context-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  const dataDir = join(root, 'data');
  const dockerSocket = join(root, 'docker.sock');

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

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

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // impd boots with a root token, the bearer a raw build sends
  const rootToken = faker.string.alphanumeric(32);

  const impd = await createImpd(config, {
    db,
    rootToken,
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

    // the host's free space, so a build never meets this machine's disk
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
  });

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
    root,
    dockerSocket,
    rootToken,
    apiUrl: `http://127.0.0.1:${String(impd.api.app.server?.port)}`,
  };
}

test('#writeBuildContext makes a named directory that holds the Dockerfile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'build-context-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const dir = await writeBuildContext(root, 'syntax', 'FROM busybox:1.37\n');
  const dockerfile = await readFile(join(root, 'syntax', 'Dockerfile'), 'utf8');

  expect(dir).toBe(join(root, 'syntax'));
  expect(dockerfile).toBe('FROM busybox:1.37\n');
});

test('#sendRawBuild builds a tar of exactly the named files on impd under the token and image name', async () => {
  const ctx = await setupTest();

  const imageId = `sha256:${'b'.repeat(64)}`;

  const docker = createStubDockerBin(ctx.root, {
    'imp/e2e-img-raw:latest': { id: imageId, repoDigests: [], files: { hello: 'built\n' } },
  });

  updateEnv('PATH', `${docker.binDir}:${process.env['PATH'] ?? ''}`);

  const engine = startStubDockerEngine({ socketPath: ctx.dockerSocket, imageId });

  const dir = await writeBuildContext(ctx.root, 'ctx', 'FROM scratch\nCOPY kept.txt /\n');

  await writeFile(join(dir, 'kept.txt'), 'kept');
  await writeFile(join(dir, 'left-out.txt'), 'left out');

  const response = await sendRawBuild({
    apiUrl: ctx.apiUrl,
    token: ctx.rootToken,
    dir,
    files: ['Dockerfile', 'kept.txt'],
    name: 'e2e-img-raw',
  });

  const built: unknown = await response.json();

  const listed = Bun.spawnSync(['tar', '-tf', '-'], {
    stdin: engine.contexts.at(0) ?? new Uint8Array(),
  }).stdout.toString();

  expect(response.status).toBe(200);
  expect(built).toMatchObject({ name: 'e2e-img-raw', ref: 'imp/e2e-img-raw:latest' });
  expect(listed).toBe('Dockerfile\nkept.txt\n');
});

test('#sendRawBuild answers impd’s refusal of another token', async () => {
  const ctx = await setupTest();
  const dir = await writeBuildContext(ctx.root, 'ctx', 'FROM busybox:1.37\n');

  const response = await sendRawBuild({
    apiUrl: ctx.apiUrl,
    token: 'imp_wrong',
    dir,
    files: ['Dockerfile'],
    name: 'e2e-img-raw',
  });

  expect(response.status).toBe(401);
});

test('#sendRawBuild throws with tar’s reason when a named file is missing', async () => {
  const ctx = await setupTest();
  const dir = await writeBuildContext(ctx.root, 'ctx', 'FROM busybox:1.37\n');

  expect(
    sendRawBuild({
      apiUrl: ctx.apiUrl,
      token: ctx.rootToken,
      dir,
      files: ['missing.txt'],
      name: 'e2e-img-raw',
    }),
  ).rejects.toThrowWithMessage(Error, /^tar exited 2: .*missing\.txt/);
});
