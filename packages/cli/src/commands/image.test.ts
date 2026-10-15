import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { createImage } from '@imp/daemon/src/db/images';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { DOCKERFILE_FRONTEND } from '@imp/daemon/src/docker-proxy/dockerfile-frontend';
import {
  buildImagePaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildMockNewImage } from '@imp/daemon/src/test-utils/build-mock-new-image';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubTracedBuild } from '@imp/daemon/src/test-utils/build-stub-traced-build';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { createStubDockerCli } from '@imp/daemon/src/test-utils/create-stub-docker-cli';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { startStubDockerEngine } from '@imp/daemon/src/test-utils/start-stub-docker-engine';
import { invariant } from '@imp/test-utils/invariant';
import { updateEnv } from '@imp/test-utils/update-env';
import { waitFor } from '@imp/test-utils/wait-for';
import { runCli } from '../test-utils/start-cli';

// impd's real app, listening on a loopback port for the spawned CLI
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-image-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the engine a host build sends its context to
  const engine = startStubDockerEngine({ dir: dataDir });

  stack.defer(() => engine.stop());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one; builds
  // run on the host's engine, the stub
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    IMP_BUILD_ISOLATION: 'host',
    DOCKER_HOST: engine.dockerHost,
  });

  // the system drive impd boots with
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // impd boots with a root bearer; each test reads it back for the CLI
  const rootToken = faker.string.alphanumeric(32);

  const impd = await createImpd(config, {
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

    // the host's free space, so boot never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // Firecracker and the CPU, which the test host may not have
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

    // no IPv6 routes, tailnet, cgroups, taps or VMs on the test host
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },

    // no broker bundle, tunnel or OAuth timer without a guest network
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },

    // nft, conntrack and the uplinks belong to the host, not the test
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

    // the VMs' memory as /proc would show it
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

  const app = impd.api.app.listen({ port: 0, hostname: '127.0.0.1' });

  stack.defer(async () => {
    await app.stop(true);
  });

  invariant(app.server?.port);

  return {
    rootToken,
    db,
    dataDir,
    engine,
    url: `http://127.0.0.1:${String(app.server.port)}`,
  };
}

test('#imageCommand prints progress lines and the step output of a build whose stderr is no terminal', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = createStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  ctx.engine.setAnswer(buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}` }));

  const result = await runCli({
    args: ['image', 'build', join(ctx.dataDir, 'context'), '--name', 'web'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result.code).toBe(0);

  expect(result.stderr.split('\n')).toIncludeAllMembers([
    expect.stringMatching(/^imp image build: uploading, 0m\d\ds$/v),
    expect.stringMatching(/^imp image build: building, 0m\d\ds$/v),
    expect.stringMatching(
      /^imp image build: building, 0m\d\ds, \[2\/3\] RUN echo compiling widget && echo second line$/v,
    ),
    '#1 [2/3] RUN echo compiling widget && echo second line',
    '#1 compiling widget',
    '#1 second line',
    expect.stringMatching(/^imp image build: unpacking, 0m\d\ds, \[2\/3\] RUN echo compiling/v),
  ]);

  expect(result.stdout).toStartWith('NAME');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#imageCommand prints no progress and no step output for --quiet', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = createStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  ctx.engine.setAnswer(buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}` }));

  const result = await runCli({
    args: ['image', 'build', join(ctx.dataDir, 'context'), '--name', 'web', '-q'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toStartWith('NAME');
});

test('#imageCommand prints the image as JSON alone on stdout with --json, and the progress on stderr', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = createStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  ctx.engine.setAnswer(buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}` }));

  const result = await runCli({
    args: ['image', 'build', join(ctx.dataDir, 'context'), '--name', 'web', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(result.code).toBe(0);
  expect(printed).toMatchObject({ name: 'web', ref: 'imp/web:latest', source: 'oci' });
  expect(result.stderr).toInclude('#1 compiling widget\n');
});

test('#imageCommand lists a running build with its start and step from another shell', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = createStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  // the engine holds the build in its RUN step until the listing is read
  const hold = Promise.withResolvers<void>();

  onTestFinished(() => {
    hold.resolve();
  });

  updateEnv('PATH', docker.path);

  ctx.engine.setAnswer(
    buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}`, hold: hold.promise }),
  );

  const before = new Date();

  const building = runCli({
    args: ['image', 'build', join(ctx.dataDir, 'context'), '--name', 'web', '-q'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const listedJson = await waitFor(async () => {
    const result = await runCli({
      args: ['image', 'builds', '--json'],
      env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    });

    const builds = JSON.parse(result.stdout) as { step: string | null }[];

    invariant(builds[0]?.step);

    return result.stdout;
  });

  const listed: unknown = JSON.parse(listedJson);

  const table = await runCli({
    args: ['image', 'builds'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  hold.resolve();

  const built = await building;

  expect(listed).toStrictEqual([
    {
      name: 'web',
      source: 'upload',
      startedAt: expect.toSatisfy(
        (startedAt: string) => Date.parse(startedAt) >= before.getTime() - 1000,
      ),
      phase: 'build',
      step: '[2/3] RUN echo compiling widget && echo second line',
      builder: null,
    },
  ]);

  expect(table.stdout.split('\n')).toStrictEqual([
    expect.stringMatching(/^NAME +SOURCE +STARTED +ELAPSED +PHASE +STEP +BUILDER *$/v),
    expect.stringMatching(
      /^web +upload +\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ +\d+s +build +\[2\/3\] RUN echo compiling widget && echo second line +- *$/v,
    ),
    '',
  ]);

  expect(built.code).toBe(0);
});

test('#imageCommand refuses a relative path for --on-host, which names no directory on the impd host', async () => {
  const result = await runCli({
    args: ['image', 'build', 'images/base', '--name', 'base', '--on-host'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --on-host takes an absolute path on the impd host, not images/base\n',
    code: 2,
  });
});

test('#imageCommand refuses a build context without a Dockerfile before any upload', async () => {
  const context = await mkdtemp(join(tmpdir(), 'imp-empty-context-'));

  onTestFinished(() => rm(context, { recursive: true, force: true }));

  const result = await runCli({
    args: ['image', 'build', context, '--name', 'base'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  const received: unknown = result;

  expect(received).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/^imp: there is no Dockerfile in /u) as unknown,
    code: 2,
  });
});

test('#templateCommand refuses to remove a docker image as a template', async () => {
  const ctx = await setupTest();

  // a docker image, with a rootfs where its digest names
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const result = await runCli({
    args: ['template', 'rm', 'ubuntu'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: ubuntu is a docker image, not a template: use imp image rm\n',
    code: 2,
  });
});
