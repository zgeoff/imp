import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { createImage } from '@imp/daemon/src/db/images';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import {
  buildImagePaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { ORPCError } from '@orpc/client';
import { createImpClient } from '@zgeoff/imp-client';
import { printEvents } from './events';

// impd's real app, listening on a loopback port for the spawned CLI, and an
// in-process client of it
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-events-'));

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

  // the system drive impd boots with
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,

    // the bearer the CLI sends
    rootToken: 'root-token',
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

  const port = findFreePorts(1).take();

  impd.api.app.listen({ port, hostname: '127.0.0.1' });

  // a test may have stopped it already
  stack.defer(async () => {
    if (impd.api.app.server !== null) {
      await impd.api.app.stop(true);
    }
  });

  const sendRequest = (request: Request) => impd.api.app.handle(request);

  return {
    stack,
    sendRequest,
    client: createImpClient({ url: 'http://impd.test', token: 'root-token', fetch: sendRequest }),
    db,
    dataDir,
    url: `http://127.0.0.1:${String(port)}`,
    stopListener: () => impd.api.app.stop(true),
    startListener: () => impd.api.app.listen({ port, hostname: '127.0.0.1' }),
  };
}

test('it prints only the named imp’s events, and reconnects after impd’s connection drops', async () => {
  const ctx = await setupTest();

  await createImage(ctx.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');
  await ctx.client.imps.create({ name: 'dev', image: 'base' });
  await ctx.client.imps.create({ name: 'web', image: 'base' });

  const live = createImpClient({ url: ctx.url, token: 'root-token' });
  const warn = mock<(line: string) => void>();

  const wait = mock((ms: number) => {
    // impd comes back for the first reconnect only
    if (ms === 1000) {
      ctx.startListener();
    }

    return Promise.resolve();
  });

  // each line drops impd's connection, as a restart does
  const print = mock<(line: string) => void>(() => {
    void ctx.stopListener();
  });

  const printing = printEvents(
    {
      openStream: () => live.events.stream(),
      checkServer: () => live.checkServer(),
      now: Date.now,
      wait,
      warn,
    },
    'dev',
    print,
  );

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: Unable to connect. Is the computer able to access the url?',
  );

  expect(print.mock.calls.map(([line]) => JSON.parse(line) as unknown)).toStrictEqual([
    expect.objectContaining({
      ev: 'ImpAdded',
      reason: 'snapshot',
      imp: expect.objectContaining({ name: 'dev' }) as unknown,
    }),
    expect.objectContaining({
      ev: 'ImpAdded',
      reason: 'snapshot',
      imp: expect.objectContaining({ name: 'dev' }) as unknown,
    }),
  ]);

  expect(wait.mock.calls).toStrictEqual([[1000], [2000], [4000], [8000]]);

  expect(warn.mock.calls).toStrictEqual([
    [
      'imp: the event stream ended (The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()); reconnecting in 1000ms',
    ],
    [
      'imp: the event stream ended (The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()); reconnecting in 2000ms',
    ],
    [
      'imp: the event stream ended (Unable to connect. Is the computer able to access the url?); reconnecting in 4000ms',
    ],
    [
      'imp: the event stream ended (Unable to connect. Is the computer able to access the url?); reconnecting in 8000ms',
    ],
  ]);
});

test('it prints every imp’s events when no imp is named', async () => {
  const ctx = await setupTest();

  await createImage(ctx.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');
  await ctx.client.imps.create({ name: 'dev', image: 'base' });
  await ctx.client.imps.create({ name: 'web', image: 'base' });

  const live = createImpClient({ url: ctx.url, token: 'root-token' });
  const lines: string[] = [];

  const printing = printEvents(
    {
      openStream: () => live.events.stream(),
      checkServer: () => live.checkServer(),
      now: Date.now,
      wait: () => Promise.resolve(),
      warn: () => {},
    },
    null,
    (line) => {
      lines.push(line);

      // both snapshot lines are in, so impd's connection drops
      if (lines.length === 2) {
        void ctx.stopListener();
      }
    },
  );

  expect(printing).rejects.toThrow();

  expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
    expect.objectContaining({
      ev: 'ImpAdded',
      imp: expect.objectContaining({ name: 'dev' }) as unknown,
    }),
    expect.objectContaining({
      ev: 'ImpAdded',
      imp: expect.objectContaining({ name: 'web' }) as unknown,
    }),
  ]);
});

test('it starts the count and the backoff again after a stream that lasted', async () => {
  const ctx = await setupTest();

  await ctx.stopListener();

  const live = createImpClient({ url: ctx.url, token: 'root-token' });
  const clock = { now: 0 };

  const wait = mock((ms: number) => {
    clock.now += ms;

    // impd is back for the third try
    if (wait.mock.calls.length === 2) {
      ctx.startListener();
    }

    return Promise.resolve();
  });

  const printing = printEvents(
    {
      openStream: async () => {
        const stream = await live.events.stream();

        // the stream that opens lasts 20 s, then impd's connection drops
        clock.now += 20_000;
        void ctx.stopListener();

        return stream;
      },
      checkServer: () => live.checkServer(),
      now: () => clock.now,
      wait,
      warn: () => {},
    },
    null,
    () => {},
  );

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: Unable to connect. Is the computer able to access the url?',
  );

  expect(wait.mock.calls).toStrictEqual([[1000], [2000], [1000], [2000], [4000], [8000]]);
});

test('it reconnects after impd fails the stream with a server error', async () => {
  const ctx = await setupTest();

  // the snapshot read fails on a closed database, as on a failed disk
  await ctx.db.destroy();

  const warn = mock<(line: string) => void>();

  const printing = printEvents(
    {
      openStream: () => ctx.client.events.stream(),
      checkServer: () => ctx.client.checkServer(),
      now: Date.now,
      wait: () => Promise.resolve(),
      warn,
    },
    null,
    () => {},
  );

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'the event stream ended 5 times in a row: Internal server error',
  );

  expect(warn.mock.calls[0]).toStrictEqual([
    'imp: the event stream ended (Internal server error); reconnecting in 1000ms',
  ]);
});

test('it rethrows impd’s refusal of a token it does not know, without retrying', async () => {
  const ctx = await setupTest();

  const stranger = createImpClient({
    url: 'http://impd.test',
    token: 'not-a-token',
    fetch: ctx.sendRequest,
  });

  const wait = mock<(ms: number) => Promise<void>>(() => Promise.resolve());

  const printing = printEvents(
    {
      openStream: () => stranger.events.stream(),
      checkServer: () => stranger.checkServer(),
      now: Date.now,
      wait,
      warn: () => {},
    },
    null,
    () => {},
  );

  expect(printing).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  expect(wait).not.toHaveBeenCalled();
});

// impd answers a procedure it does not have with a plain-text 404 that the
// client cannot parse, so no real impd, older or current, reaches this
// branch; its input here is the NOT_FOUND an oRPC router sends
test('it says to upgrade an impd that answers NOT_FOUND for the stream', () => {
  const printing = printEvents(
    {
      openStream: () => Promise.reject(new ORPCError('NOT_FOUND', { status: 404 })),
      checkServer: () =>
        Promise.resolve({ clientVersion: '0.3.0', serverVersion: '0.2.2', compatible: false }),
      now: Date.now,
      wait: () => Promise.resolve(),
      warn: () => {},
    },
    null,
    () => {},
  );

  expect(printing).rejects.toThrowWithMessage(
    Error,
    'impd 0.2.2 has no event stream; upgrade it to 0.3.0',
  );
});
