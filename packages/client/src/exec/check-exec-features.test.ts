import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@impz/daemon/src/config';
import { createImpd } from '@impz/daemon/src/create-impd';
import type { ImpdDeps } from '@impz/daemon/src/create-impd';
import { openDatabase } from '@impz/daemon/src/db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@impz/daemon/src/storage/data-layout';
import { createXfsBackend } from '@impz/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@impz/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@impz/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@impz/daemon/src/test-utils/find-free-ports';
import { server } from '@impz/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { createRpcClient } from '../create-rpc-client';
import { buildStubImpdWithoutFeature } from '../test-utils/build-stub-impd-without-feature';
import { checkExecFeatures } from './check-exec-features';

// impd booted in process on stub VMs, served at http://impd.test/ through
// the run's MSW server
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root token, the bearer the test's client sends
  const rootToken = 'root-token';

  const dataDir = await mkdtemp(join(tmpdir(), 'imp-client-require-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

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

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
  });

  const impd = await createImpd(config, deps);

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  server.use(http.all('http://impd.test/*', (info) => impd.api.app.handle(info.request)));

  return { impd, url: 'http://impd.test', rootToken };
}

test('it passes an impd that checks exec requirements', async () => {
  const ctx = await setupTest();

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toBeNull();
});

test('it sends the bearer token with the check', async () => {
  const ctx = await setupTest();

  const received = mock<(authorization: string | null) => void>();

  server.use(
    http.post('http://impd.test/rpc/system/features', (info) => {
      received(info.request.headers.get('authorization'));

      return ctx.impd.api.app.handle(info.request);
    }),
  );

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(received).toHaveBeenCalledExactlyOnceWith(`Bearer ${ctx.rootToken}`);
});

test('it reads the features once for several needs', async () => {
  const ctx = await setupTest();

  const received = mock<() => void>();

  server.use(
    http.post('http://impd.test/rpc/system/features', (info) => {
      received();

      return ctx.impd.api.app.handle(info.request);
    }),
  );

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  await checkExecFeatures(rpc, {
    execRequire: 'run it unchecked',
    execDropSysAdmin: 'run it with CAP_SYS_ADMIN',
  });

  expect(received).toHaveBeenCalledOnce();
});

test('it reports an impd that rejects the token as unauthorized', async () => {
  const ctx = await setupTest();

  const rpc = createRpcClient({ url: ctx.url, token: 'wrong' });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toStrictEqual({ kind: 'unauthorized' });
});

test('it refuses an impd from before exec requirements as PRECONDITION_FAILED', async () => {
  const ctx = await setupTest();

  const older = buildStubImpdWithoutFeature(
    (request) => ctx.impd.api.app.handle(request),
    'execRequire',
  );

  server.use(http.all('http://impd.test/*', (info) => older(info.request)));

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  const refusal = await checkExecFeatures(rpc, {
    execRequire: 'run the command without checking its requirements',
  });

  expect(refusal).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message:
      'nothing was started: this impd is older than 0.30.0 and would run the command without checking its requirements',
    data: {
      reason: 'impd_outdated',
      detail:
        'this impd is older than 0.30.0 and would run the command without checking its requirements',
    },
  });
});

test('it refuses an impd that cannot drop CAP_SYS_ADMIN as PRECONDITION_FAILED', async () => {
  const ctx = await setupTest();

  const older = buildStubImpdWithoutFeature(
    (request) => ctx.impd.api.app.handle(request),
    'execDropSysAdmin',
  );

  server.use(http.all('http://impd.test/*', (info) => older(info.request)));

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  const refusal = await checkExecFeatures(rpc, {
    execDropSysAdmin: 'run the command with CAP_SYS_ADMIN',
  });

  expect(refusal).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message:
      'nothing was started: this impd cannot drop CAP_SYS_ADMIN from a command and would run the command with CAP_SYS_ADMIN',
    data: {
      reason: 'impd_outdated',
      detail:
        'this impd cannot drop CAP_SYS_ADMIN from a command and would run the command with CAP_SYS_ADMIN',
    },
  });
});

test('it reports an impd it cannot reach as unreachable', async () => {
  // nothing listens on a free port
  const rpc = createRpcClient({
    url: `http://127.0.0.1:${String(findFreePorts(1).take())}`,
    token: 'root-token',
  });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toStrictEqual({
    kind: 'unreachable',
    detail: expect.toStartWith('feature check: '),
  });
});

test('it refuses a start when impd fails the check', async () => {
  // a proxy in front of impd answers while impd is down
  server.use(
    http.post(
      'http://impd.test/rpc/system/features',
      () => new HttpResponse('down', { status: 503 }),
    ),
  );

  const rpc = createRpcClient({ url: 'http://impd.test', token: 'root-token' });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toStrictEqual({
    kind: 'failed',
    code: null,
    message: 'impd answered the feature check with 503; nothing was started',
  });
});

test('it refuses a start when impd answers the check with no feature flags', async () => {
  // a features answer without its flags, which no impd sends
  server.use(
    http.post('http://impd.test/rpc/system/features', () =>
      HttpResponse.json({ json: { version: '0.40.1' } }),
    ),
  );

  const rpc = createRpcClient({ url: 'http://impd.test', token: 'root-token' });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toMatchObject({ kind: 'failed', code: 'PRECONDITION_FAILED' });
});
