import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { createImpClient } from '@impz/client';
import { loadConfig } from '@impz/daemon/src/config';
import { createImpd } from '@impz/daemon/src/create-impd';
import { createImage } from '@impz/daemon/src/db/images';
import { openDatabase } from '@impz/daemon/src/db/open-database';
import { createGenerationLog } from '@impz/daemon/src/session-logs/generation-log';
import {
  buildImagePaths,
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@impz/daemon/src/storage/data-layout';
import { createXfsBackend } from '@impz/daemon/src/storage/xfs-backend';
import { buildMockNewImage } from '@impz/daemon/src/test-utils/build-mock-new-image';
import { buildStubCpuCgroups } from '@impz/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@impz/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@impz/daemon/src/test-utils/find-free-ports';
import invariant from 'tiny-invariant';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { startStubOlderImpd } from '../test-utils/start-stub-older-impd';

// impd, listening for the spawned CLI
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-session-logs-'));

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

  // the system drive impd boots imps with
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // impd boots with a root bearer; the CLI reads it back from env
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

  const port = app.server?.port;

  invariant(port !== undefined);

  const sendRequest = (request: Request) => impd.api.app.handle(request);

  const client = createImpClient({
    url: 'http://impd.test',
    token: rootToken,
    fetch: sendRequest,
  });

  return {
    stack,
    dataDir,
    db,
    sendRequest,
    client,
    rootToken,
    env: { IMP_URL: `http://127.0.0.1:${String(port)}`, IMP_TOKEN: rootToken },
  };
}

test('it writes the newest log to stdout and the bytes the log lost to stderr', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const generation = 'c'.repeat(32);

  const log = await createGenerationLog(
    {
      dir: join(buildImpPaths(ctx.dataDir, imp.id).sessionLogsDir, generation),
      segmentBytes: 64,
      maxBytes: 128,
      requireRoom: () => Promise.resolve(),
      now: () => Date.UTC(2026, 9, 4),
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: generation,
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  log.setOrigin(4);

  await log.append(new TextEncoder().encode('abcdef'));
  await log.finish({ end: 10, exitCode: 0 });

  const result = await runCLIInProcess({ args: ['sessions', 'log', 'dev', 'main'], env: ctx.env });

  expect(result).toStrictEqual({
    stdout: 'abcdef',
    stderr: `impz: generation ${generation}\nimpz: bytes 0 to 4 are not in the log\n`,
    code: 0,
  });
});

test('it reads a named generation from the --from offset', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const generation = 'c'.repeat(32);

  const log = await createGenerationLog(
    {
      dir: join(buildImpPaths(ctx.dataDir, imp.id).sessionLogsDir, generation),
      segmentBytes: 64,
      maxBytes: 128,
      requireRoom: () => Promise.resolve(),
      now: () => Date.UTC(2026, 9, 4),
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: generation,
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  log.setOrigin(4);

  await log.append(new TextEncoder().encode('abcdef'));
  await log.finish({ end: 10, exitCode: 0 });

  const result = await runCLIInProcess({
    args: ['sessions', 'log', 'dev', 'main', generation, '--from', '6'],
    env: ctx.env,
  });

  expect(result).toStrictEqual({ stdout: 'cdef', stderr: '', code: 0 });
});

test('it refuses a --from that is not a whole number of bytes', async () => {
  const result = await runCLIInProcess({
    args: ['sessions', 'log', 'dev', 'main', '--from=-1'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --from must be at least 0, not -1\n',
    code: 2,
  });
});

test.each([
  [
    'log with no session',
    ['sessions', 'log', 'dev'],
    'usage: impz sessions log <name> <session> [generation] [--from <offset>]',
  ],
  [
    'log with a fourth positional',
    ['sessions', 'log', 'dev', 'main', 'c', 'd'],
    'usage: impz sessions log <name> <session> [generation] [--from <offset>]',
  ],
  ['logs with no name', ['sessions', 'logs'], 'usage: impz sessions logs <name> [session]'],
  [
    'logs with a third positional',
    ['sessions', 'logs', 'dev', 'main', 'c'],
    'usage: impz sessions logs <name> [session]',
  ],
  [
    'log-rm with no name',
    ['sessions', 'log-rm'],
    'usage: impz sessions log-rm <name> [session] [generation]',
  ],
  [
    'log-rm with a fourth positional',
    ['sessions', 'log-rm', 'dev', 'main', 'c', 'd'],
    'usage: impz sessions log-rm <name> [session] [generation]',
  ],
])('it prints the usage for %s', async (_case, args, usage) => {
  const result = await runCLIInProcess({ args, env: { IMP_URL: 'http://127.0.0.1:1' } });

  expect(result).toStrictEqual({ stdout: '', stderr: `impz: ${usage}\n`, code: 2 });
});

test('it says the imp has no log of a session that never logged', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'dev' });

  const result = await runCLIInProcess({ args: ['sessions', 'log', 'dev', 'main'], env: ctx.env });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: imp dev has no log of session main\n',
    code: 1,
  });
});

test('it lists the logs of an imp as JSON', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const generation = 'c'.repeat(32);

  const log = await createGenerationLog(
    {
      dir: join(buildImpPaths(ctx.dataDir, imp.id).sessionLogsDir, generation),
      segmentBytes: 64,
      maxBytes: 128,
      requireRoom: () => Promise.resolve(),
      now: () => Date.UTC(2026, 9, 4),
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: generation,
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  log.setOrigin(4);

  await log.append(new TextEncoder().encode('abcdef'));
  await log.finish({ end: 10, exitCode: 0 });

  const result = await runCLIInProcess({
    args: ['sessions', 'logs', 'dev', '--json'],
    env: ctx.env,
  });

  const listed: unknown = JSON.parse(result.stdout);

  expect(listed).toStrictEqual([
    {
      session: 'main',
      executionGeneration: generation,
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      state: 'ended',
      logStart: 4,
      logEnd: 10,
      bytes: 6,
      end: 10,
      exitCode: 0,
      complete: false,
      startedAt: '2026-10-04T00:00:00.000Z',
      endedAt: '2026-10-04T00:00:00.000Z',
    },
  ]);
});

test('it deletes the logs of the session it names', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const generation = 'c'.repeat(32);
  const dir = join(buildImpPaths(ctx.dataDir, imp.id).sessionLogsDir, generation);

  const log = await createGenerationLog(
    {
      dir,
      segmentBytes: 64,
      maxBytes: 128,
      requireRoom: () => Promise.resolve(),
      now: () => Date.UTC(2026, 9, 4),
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: generation,
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  await log.append(new TextEncoder().encode('abcdef'));
  await log.finish({ end: 6, exitCode: 0 });

  const result = await runCLIInProcess({
    args: ['sessions', 'log-rm', 'dev', 'main'],
    env: ctx.env,
  });

  expect(result).toStrictEqual({
    stdout: 'deleted 1 session logs of dev\n',
    stderr: '',
    code: 0,
  });

  expect(existsSync(dir)).toBe(false);
});

test('it never deletes the logs of another session or another imp', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const dev = await ctx.client.imps.create({ name: 'dev' });
  const web = await ctx.client.imps.create({ name: 'web' });

  const named = join(buildImpPaths(ctx.dataDir, dev.id).sessionLogsDir, 'c'.repeat(32));

  const namedLog = await createGenerationLog(
    {
      dir: named,
      segmentBytes: 64,
      maxBytes: 128,
      requireRoom: () => Promise.resolve(),
      now: () => Date.UTC(2026, 9, 4),
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'c'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  await namedLog.append(new TextEncoder().encode('abcdef'));
  await namedLog.finish({ end: 6, exitCode: 0 });

  const otherSession = join(buildImpPaths(ctx.dataDir, dev.id).sessionLogsDir, 'd'.repeat(32));

  const otherSessionLog = await createGenerationLog(
    {
      dir: otherSession,
      segmentBytes: 64,
      maxBytes: 128,
      requireRoom: () => Promise.resolve(),
      now: () => Date.UTC(2026, 9, 4),
      log: () => {},
    },
    {
      session: 'work',
      executionGeneration: 'd'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  await otherSessionLog.append(new TextEncoder().encode('abcdef'));
  await otherSessionLog.finish({ end: 6, exitCode: 0 });

  const otherImp = join(buildImpPaths(ctx.dataDir, web.id).sessionLogsDir, 'e'.repeat(32));

  const otherImpLog = await createGenerationLog(
    {
      dir: otherImp,
      segmentBytes: 64,
      maxBytes: 128,
      requireRoom: () => Promise.resolve(),
      now: () => Date.UTC(2026, 9, 4),
      log: () => {},
    },
    {
      session: 'main',
      executionGeneration: 'e'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  await otherImpLog.append(new TextEncoder().encode('abcdef'));
  await otherImpLog.finish({ end: 6, exitCode: 0 });

  const result = await runCLIInProcess({
    args: ['sessions', 'log-rm', 'dev', 'main'],
    env: ctx.env,
  });

  expect(result).toStrictEqual({
    stdout: 'deleted 1 session logs of dev\n',
    stderr: '',
    code: 0,
  });

  expect([existsSync(named), existsSync(otherSession), existsSync(otherImp)]).toStrictEqual([
    false,
    true,
    true,
  ]);
});

test('it refuses to read a log from an impd from before sessionLog, before any read', async () => {
  const ctx = await setupTest();

  const older = startStubOlderImpd(ctx.stack, ctx.sendRequest, { withoutFeatures: ['sessionLog'] });

  const result = await runCLIInProcess({
    args: ['sessions', 'log', 'dev', 'main'],
    env: { IMP_URL: older.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: this impd has no session logs and would read no log; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(older.calls).toStrictEqual(['system/features']);
});
