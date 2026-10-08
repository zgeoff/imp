import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXEC_MAX_STDIN_FRAME_BYTES, EXEC_STDIN_WINDOW_BYTES } from '@imp/api';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeJsonFrame,
} from '@imp/daemon/src/agent-client/frame-codec';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { createImage } from '@imp/daemon/src/db/images';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { readVmIdentity, writeVmIdentity } from '@imp/daemon/src/sleep/vm-identity';
import {
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { startStubAgent } from '@imp/daemon/src/test-utils/start-stub-agent';
import { listLocalEntries, writeLocalEntries } from '@imp/local-tar';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import tar from 'tar-stream';
import { buildStubExecPeer } from '../test-utils/build-stub-exec-peer';
import { openToolExec } from './open-tool-exec';

// impd, booted on stand-ins and listening on a loopback port, with a
// running imp `box` whose agent each test starts on its vsock path
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'exec-client-'));

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

  invariant(app.server?.port);

  const url = `http://127.0.0.1:${String(app.server.port)}`;

  // the image the imp is created from
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const imp = await createImpClient({ url, token: 'root-token' }).imps.create({ name: 'box' });

  return {
    config: { url, token: 'root-token', host: null },
    paths: buildImpPaths(dataDir, imp.id),
  };
}

test('it sends an archive whole through impd to the imp’s tool and returns its exit code', async () => {
  const ctx = await setupTest();

  const identity = readVmIdentity(ctx.paths);

  invariant(identity);

  // an agent with imp cp
  writeVmIdentity(ctx.paths, { ...identity, agentVersion: '0.18.0' });

  const archive = tar.extract();
  const names: string[] = [];

  const reading = (async () => {
    for await (const entry of archive) {
      names.push(
        `${entry.header.name} ${entry.header.type} ${(entry.header.mode & 0o777).toString(8)}`,
      );

      entry.resume();
    }
  })();

  const agent = await startStubAgent(ctx.paths.vsockSocket, (socket, _request, frames) => {
    const frame = frames.at(-1);

    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
    } else if (frame?.type === FRAME_TYPES.stdin) {
      archive.write(frame.payload);
    } else {
      archive.end(null);
      socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
    }
  });

  const dir = await mkdtemp(join(tmpdir(), 'open-tool-exec-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'proj'), { mode: 0o750 });

  await writeFile(join(dir, 'proj', 'big.bin'), new Uint8Array(4 * EXEC_STDIN_WINDOW_BYTES), {
    mode: 0o600,
  });

  await symlink('big.bin', join(dir, 'proj', 'link'));

  const entries = await listLocalEntries(join(dir, 'proj'));

  const exec = await openToolExec({
    config: ctx.config,
    name: 'box',
    tool: 'tar',
    args: ['extract', '/srv/proj'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
  });

  await writeLocalEntries(entries, exec.writeStdin, { add: () => {} }, () => {});

  exec.endStdin();

  const code = await exec.waitExit();

  await reading;

  const [request] = agent.received;

  invariant(request);

  expect(code).toBe(0);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'exec',
    argv: ['/run/imp/sys/imp-agent', 'tar', 'extract', '/srv/proj'],
    tty: false,
    user: 'root',
  });

  expect(names).toStrictEqual([
    'proj/ directory 750',
    'proj/big.bin file 600',
    'proj/link symlink 777',
  ]);
});

test('it rejects with impd’s code and message when impd refuses the exec', async () => {
  const ctx = await setupTest();

  // the stub VMM records an agent from before imp cp
  const opening = openToolExec({
    config: ctx.config,
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
  });

  expect(opening).rejects.toThrowWithMessage(
    Error,
    "AGENT_OUTDATED: the imp's agent has no imp cp yet; stop and start the imp to update it",
  );
});

test('it holds stdin at the window when impd withholds its acks', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 9 });
    }
  });

  const exec = await openToolExec({
    config: { url: 'http://impd.test', token: 'root-token', host: null },
    name: 'box',
    tool: 'tar',
    args: ['extract', '/srv/proj'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
    connect: peer.connect,
  });

  onTestFinished(exec.close);

  // a window and two frames: the last frame needs an ack to go
  const writing = exec.writeStdin(
    new Uint8Array(EXEC_STDIN_WINDOW_BYTES + 2 * EXEC_MAX_STDIN_FRAME_BYTES),
  );

  await waitFor(() => {
    expect(
      peer.received.reduce((total, message) => total + ('bytes' in message ? message.bytes : 0), 0),
    ).toBe(EXEC_STDIN_WINDOW_BYTES + EXEC_MAX_STDIN_FRAME_BYTES);
  });

  expect(Bun.peek.status(writing)).toBe('pending');

  expect(
    peer.received.flatMap((message) => (message.type === 'stdin' ? [message.bytes] : [])),
  ).toSatisfyAll((bytes: number) => bytes <= EXEC_MAX_STDIN_FRAME_BYTES);
});

test('it sends the rest of stdin once impd acks the window', async () => {
  const link = { ack: (bytes: number): void => void bytes };

  const peer = buildStubExecPeer((peerLink, message) => {
    if (message.type === 'start') {
      peerLink.send({ type: 'started', pid: 9 });

      link.ack = (bytes) => {
        peerLink.send({ type: 'stdin_ack', bytes });
      };
    }
  });

  const exec = await openToolExec({
    config: { url: 'http://impd.test', token: 'root-token', host: null },
    name: 'box',
    tool: 'tar',
    args: ['extract', '/srv/proj'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
    connect: peer.connect,
  });

  onTestFinished(exec.close);

  const writing = exec.writeStdin(
    new Uint8Array(EXEC_STDIN_WINDOW_BYTES + 2 * EXEC_MAX_STDIN_FRAME_BYTES),
  );

  await waitFor(() => {
    expect(
      peer.received.reduce((total, message) => total + ('bytes' in message ? message.bytes : 0), 0),
    ).toBe(EXEC_STDIN_WINDOW_BYTES + EXEC_MAX_STDIN_FRAME_BYTES);
  });

  link.ack(EXEC_STDIN_WINDOW_BYTES);

  await writing;

  expect(
    peer.received.reduce((total, message) => total + ('bytes' in message ? message.bytes : 0), 0),
  ).toBe(EXEC_STDIN_WINDOW_BYTES + 2 * EXEC_MAX_STDIN_FRAME_BYTES);
});

test('it holds its stdout ack while the caller is still writing the output', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 9 });
      link.sendFrame(1, 'x'.repeat(300));
      link.sendFrame(1, 'y'.repeat(200));
    }
  });

  const seen: number[] = [];
  const writing = Promise.withResolvers<void>();

  const exec = await openToolExec({
    config: { url: 'http://impd.test', token: 'root-token', host: null },
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: async (data) => {
      seen.push(data.byteLength);

      await writing.promise;
    },
    onStderr: () => {},
    connect: peer.connect,
  });

  onTestFinished(() => {
    writing.resolve();
    exec.close();
  });

  await waitFor(() => {
    expect(seen).toStrictEqual([300, 200]);
  });

  expect(peer.received).toStrictEqual([
    { type: 'start', name: 'box', tool: 'tar', argv: ['create', 'x'], tty: false },
  ]);
});

test('it acks stdout to impd once the caller wrote it', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 9 });
      link.sendFrame(1, 'x'.repeat(300));
      link.sendFrame(1, 'y'.repeat(200));
    }
  });

  const seen: number[] = [];
  const writing = Promise.withResolvers<void>();

  const exec = await openToolExec({
    config: { url: 'http://impd.test', token: 'root-token', host: null },
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: async (data) => {
      seen.push(data.byteLength);

      await writing.promise;
    },
    onStderr: () => {},
    connect: peer.connect,
  });

  onTestFinished(exec.close);

  await waitFor(() => {
    expect(seen).toHaveLength(2);
  });

  writing.resolve();

  await waitFor(() => {
    expect(peer.received.slice(1)).toStrictEqual([
      { type: 'stdout_ack', bytes: 300 },
      { type: 'stdout_ack', bytes: 200 },
    ]);
  });
});

test('it rejects and closes the socket when impd faults with a message the protocol does not know', async () => {
  const peer = buildStubExecPeer((link) => {
    link.sendText(JSON.stringify({ type: 'progress', percent: 50 }));
  });

  const opening = openToolExec({
    config: { url: 'http://impd.test', token: 'root-token', host: null },
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
    connect: peer.connect,
  });

  expect(opening).rejects.toThrowWithMessage(Error, 'impd sent a message the CLI does not know');

  await expect(peer.closed).toResolve();
});

test('it rejects and names impd when impd faults by closing the connection unanswered', () => {
  const peer = buildStubExecPeer((link) => {
    link.close(1011, 'gone');
  });

  const opening = openToolExec({
    config: { url: 'http://impd.test', token: 'root-token', host: null },
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
    connect: peer.connect,
  });

  expect(opening).rejects.toThrowWithMessage(
    Error,
    'the connection to impd at http://impd.test closed',
  );
});

test('it rejects with impd’s code and message when impd ends the exec with an error after the start', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 9 });
    }

    if (message.type === 'stdin_eof') {
      link.send({ type: 'error', code: 'AGENT_GONE', message: 'the agent went away' });
    }
  });

  const exec = await openToolExec({
    config: { url: 'http://impd.test', token: 'root-token', host: null },
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
    connect: peer.connect,
  });

  onTestFinished(exec.close);

  exec.endStdin();

  expect(exec.waitExit()).rejects.toThrowWithMessage(Error, 'AGENT_GONE: the agent went away');
});
