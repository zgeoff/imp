import { expect, mock, test } from 'bun:test';
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
import { server } from '@imp/test-utils/mock-server';
import { createImpClient } from '@zgeoff/imp-client';
import { HttpResponse, http } from 'msw';
import { runCli } from '../test-utils/start-cli';
import { UsageError } from '../usage-error';
import { runMove } from './move';

// two impds, a and b, each with the image its imps boot from
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const startImpd = async (host: string) => {
    const dataDir = await mkdtemp(join(tmpdir(), `cli-move-${host}-`));

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

      // the URL the target hands the source, a tailnet address as a move needs
      IMP_PEER_URL: 'http://100.100.0.2:7070',
    });

    // the system drive impd boots imps with
    const drive = 'd1'.repeat(32);
    const systemDrivePath = buildSystemDrivePath(dataDir, drive);

    await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
    await writeFile(systemDrivePath, drive);

    const vmm = buildStubVmm();

    const impd = await createImpd(config, {
      db,
      rootToken: 'root-token',
      storage: createXfsBackend({
        dataDir,
        cloneFile: (source, target) => copyFile(source, target),
      }),
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

    // the image a test's imps boot from
    await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

    await createImage(db, {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
    });

    // the image's config, which a move sends with it
    await Bun.write(buildImagePaths(dataDir, 'sha256:ubuntu').config, '{}');

    const client = createImpClient({
      url: `http://${host}.test`,
      token: 'root-token',
      fetch: (request) => impd.api.app.handle(request),
    });

    return { client, moves: impd.moves };
  };

  const source = await startImpd('a');
  const target = await startImpd('b');

  const owned = stack.move();

  return {
    from: source.client,
    to: target.client,

    // the target's move routes, as the source reaches them over the
    // tailnet from 100.100.0.1
    receiveFromSource: (request: Request) => target.moves.handle(request, '100.100.0.1'),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it prepares on the source, takes a ticket from the target, then sends', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  server.use(http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)));

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  const moved = await ctx.to.imps.get({ name: 'dev' });

  expect(print).toHaveBeenCalledExactlyOnceWith('dev: moved to b');
  expect(moved.state).toBe('stopped');
});

test('it draws the send’s progress on a terminal and ends the line', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  server.use(http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)));

  const print = mock<(line: string) => void>();
  const write = mock<(text: string) => void>();

  // a clock past the redraw interval at every read, so each poll draws
  const clock = { nowMs: 0 };

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: true, write },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => (clock.nowMs += 300),
  });

  const lines = write.mock.calls.map(([text]) => text);

  expect(lines.at(-1)).toBe('\n');
  expect(lines.slice(0, -1)).not.toBeEmpty();

  expect(lines.slice(0, -1)).toSatisfyAll(
    (line: string) =>
      line.startsWith('\r') &&
      line.endsWith('\u001B[K') &&
      /^imp move: \d+% \d+\.\d MiB of \d+\.\d MiB$/u.test(line.slice(1, -3)),
  );
});

test('it moves an imp that holds leases for --stop, which ends them as imp stop does', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.leases.acquire({ name: 'dev', label: 'ci', ttlSeconds: 600 });

  server.use(http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)));

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: true,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  expect(print).toHaveBeenCalledExactlyOnceWith('dev: moved to b');
});

test('it sends the target’s facts to prepare for a sleeping imp', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.sleep({ name: 'dev' });

  const print = mock<(line: string) => void>();

  // two impds in one process never share a data dir, so the source's
  // check of the target's facts refuses the warm move it would make
  expect(
    runMove({
      name: 'dev',
      from: ctx.from,
      to: ctx.to,
      toHost: 'b',
      mode: 'move',
      stop: false,
      output: { isTTY: false, write: () => {} },
      print,
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      now: () => 0,
    }),
  ).rejects.toThrow(
    /^dev cannot move with its memory: IMP_DATA_DIR differs \(\S+cli-move-a-\S+ here, \S+cli-move-b-\S+ there\)/u,
  );
});

test('it takes the source’s mark off when the target refuses the ticket', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });
  await ctx.to.imps.create({ name: 'dev' });

  const print = mock<(line: string) => void>();

  const moving = runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  expect(moving).rejects.toThrow('this host has an imp named dev');

  const status = await ctx.from.moves.status({ name: 'dev' });

  expect(status.state).toBeNull();
});

test('it points at --resume when the target answers the commit with a 500', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  server.use(
    http.post(
      'http://100.100.0.2:7070/move/commit',
      () => new HttpResponse('boom', { status: 500 }),
    ),
    http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)),
  );

  const print = mock<(line: string) => void>();

  expect(
    runMove({
      name: 'dev',
      from: ctx.from,
      to: ctx.to,
      toHost: 'b',
      mode: 'move',
      stop: false,
      output: { isTTY: false, write: () => {} },
      print,
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      now: () => 0,
    }),
  ).rejects.toThrowWithMessage(
    Error,
    'dev: the move failed: commit: the target answered 500; run imp move dev b --resume, or --abort',
  );
});

test('it points at --abort when the network to the target is down', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  server.use(http.all('http://100.100.0.2:7070/*', () => HttpResponse.error()));

  const print = mock<(line: string) => void>();

  expect(
    runMove({
      name: 'dev',
      from: ctx.from,
      to: ctx.to,
      toHost: 'b',
      mode: 'move',
      stop: false,
      output: { isTTY: false, write: () => {} },
      print,
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      now: () => 0,
    }),
  ).rejects.toThrowWithMessage(
    Error,
    'dev: the move failed: Failed to fetch; the imp stays marked here: run imp move dev b --abort once b answers',
  );
});

test('it commits a verified move with a fresh ticket from the target on --resume', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  // the first commit meets a 500, so the target holds a verified copy
  server.use(
    http.post(
      'http://100.100.0.2:7070/move/commit',
      () => new HttpResponse('boom', { status: 500 }),
      { once: true },
    ),
    http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)),
  );

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  }).catch(() => {
    // the first run fails at the commit, as arranged
  });

  print.mockClear();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'resume',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  const moved = await ctx.to.imps.get({ name: 'dev' });

  expect(print).toHaveBeenCalledExactlyOnceWith('dev: moved to b');
  expect(moved.name).toBe('dev');
});

test('it says the move is complete when an abort finds the target committed it', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });
  await ctx.from.imps.stop({ name: 'dev' });

  // the target commits, but its answer is lost on the way back
  server.use(
    http.post(
      'http://100.100.0.2:7070/move/commit',
      async (info) => {
        await ctx.receiveFromSource(info.request);

        return HttpResponse.error();
      },
      { once: true },
    ),
    http.all('http://100.100.0.2:7070/*', (info) => ctx.receiveFromSource(info.request)),
  );

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'move',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  }).catch(() => {
    // the first run fails at the commit, as arranged
  });

  print.mockClear();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'abort',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  expect(print).toHaveBeenCalledExactlyOnceWith(
    'dev: b had committed it already; the move is complete',
  );
});

test('it says an abort leaves the imp here when no move is underway', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });

  const print = mock<(line: string) => void>();

  await runMove({
    name: 'dev',
    from: ctx.from,
    to: ctx.to,
    toHost: 'b',
    mode: 'abort',
    stop: false,
    output: { isTTY: false, write: () => {} },
    print,
    wait: () =>
      new Promise((resolve) => {
        setImmediate(resolve);
      }),
    now: () => 0,
  });

  expect(print).toHaveBeenCalledExactlyOnceWith('dev: move aborted; it stays here');
});

test('it refuses --resume of an imp with no verified move', async () => {
  await using ctx = await setupTest();

  await ctx.from.imps.create({ name: 'dev' });

  const print = mock<(line: string) => void>();

  expect(
    runMove({
      name: 'dev',
      from: ctx.from,
      to: ctx.to,
      toHost: 'b',
      mode: 'resume',
      stop: false,
      output: { isTTY: false, write: () => {} },
      print,
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
      now: () => 0,
    }),
  ).rejects.toThrowWithMessage(
    UsageError,
    'dev has no verified move to resume (state: none); run imp move again',
  );
});

test('it refuses --resume together with --abort', async () => {
  const result = await runCli({
    args: ['move', 'dev', 'b', '--resume', '--abort'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --resume and --abort do not go together\n',
    code: 2,
  });
});
