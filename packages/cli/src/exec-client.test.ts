import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { faker } from '@faker-js/faker';
import { EXEC_CHANNELS } from '@impz/api';
import { createImpClient } from '@impz/client';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '@impz/daemon/src/agent-client/frame-codec';
import { loadConfig } from '@impz/daemon/src/config';
import { createImpd } from '@impz/daemon/src/create-impd';
import { createImage } from '@impz/daemon/src/db/images';
import { openDatabase } from '@impz/daemon/src/db/open-database';
import {
  buildImagePaths,
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@impz/daemon/src/storage/data-layout';
import { createXfsBackend } from '@impz/daemon/src/storage/xfs-backend';
import { buildMockNewImage } from '@impz/daemon/src/test-utils/build-mock-new-image';
import { buildStubCpuCgroups } from '@impz/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubExecReplies } from '@impz/daemon/src/test-utils/build-stub-exec-replies';
import { buildStubVmm } from '@impz/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@impz/daemon/src/test-utils/find-free-ports';
import { startStubAgent } from '@impz/daemon/src/test-utils/start-stub-agent';
import { invariant } from '@impz/test-utils/invariant';
import { waitFor } from '@impz/test-utils/wait-for';
import * as z from 'zod';
import { runExec } from './exec-client';
import type { ExecIo } from './exec-client';
import { buildStubCongestedSocket } from './test-utils/build-stub-congested-socket';
import { buildStubExecPeer } from './test-utils/build-stub-exec-peer';
import { buildStubTerminal } from './test-utils/build-stub-terminal';
import { startCli } from './test-utils/start-cli';
import { startStubPrefixProxy } from './test-utils/start-stub-prefix-proxy';

// impd, booted on stand-ins and listening on a loopback port, and the io of
// an exec that reaches it with the root token
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

  // an agent that runs sessions, tools and outer execs, which impd checks
  vmm.agent.version = '0.18.0';

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

  // a test may stop impd's listener itself; this stop is the fallback
  stack.defer(async () => {
    if (app.server !== null) {
      await app.stop(true);
    }
  });

  const port = app.server?.port;

  invariant(port);

  const url = `http://127.0.0.1:${String(port)}`;

  const stdin = new PassThrough();

  const output: string[] = [];
  const errors: string[] = [];

  const io: ExecIo = {
    env: { IMP_URL: url, IMP_TOKEN: rootToken },
    stdin,
    writeOutput: (fd, data) => {
      output.push(`${String(fd)}:${new TextDecoder().decode(data)}`);
    },
    printError: (line) => {
      errors.push(line);
    },
  };

  return {
    stack,
    rootToken,
    dataDir,
    db,
    impd,
    client: createImpClient({ url, token: rootToken }),
    url,
    port,
    io,
    stdin,
    output,
    errors,
  };
}

test('it streams output and stdin and exits with the command’s code', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const exec = buildStubExecReplies({
    started: [
      encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }),
      encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('out')),
      encodeFrame(FRAME_TYPES.stderr, new TextEncoder().encode('err')),
    ],
    exited: [encodeJsonFrame(FRAME_TYPES.exit, { code: 3, signal: 0 })],
  });

  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, exec);

  ctx.stdin.end('typed');

  const code = await runExec({ host: null, name: 'box', argv: ['cmd'], tty: false }, ctx.io);

  const [request] = agent.received;

  invariant(request);

  expect(code).toBe(3);
  expect(ctx.output).toStrictEqual(['1:out', '2:err']);
  expect(decodeJsonPayload(request)).toStrictEqual({ op: 'exec', argv: ['cmd'], tty: false });

  expect(
    agent.received.slice(1).map((frame) => [frame.type, new TextDecoder().decode(frame.payload)]),
  ).toStrictEqual([
    [FRAME_TYPES.stdin, 'typed'],
    [FRAME_TYPES.stdinEof, ''],
  ]);
});

test('it runs an exec in the agent, outside the container, when asked for outer', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
  });

  const code = await runExec(
    { host: null, name: 'box', argv: ['ls', '/user'], tty: false, outer: true },
    ctx.io,
  );

  const [request] = agent.received;

  invariant(request);

  expect(code).toBe(0);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'exec.outer',
    argv: ['ls', '/user'],
    tty: false,
  });
});

test('it names the cause and runs nothing when impd refuses a required broker', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
  });

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false, require: ['broker'] },
    ctx.io,
  );

  expect(code).toBe(255);

  expect(ctx.errors as unknown).toStrictEqual([
    expect.stringMatching(
      /^impz: PRECONDITION_FAILED: the broker is not ready for this exec: .*no grant/u,
    ) as unknown,
  ]);

  expect(agent.received).toBeEmpty();
});

test.each([
  ['SIGKILL', 9, 137],
  ['a numbered signal', 34, 162],
])('it exits 128 + n when %s ends the command', async (_name, signal, expected) => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal }));
  });

  const code = await runExec({ host: null, name: 'box', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(expected);
});

test.each([[null], ['SIGNOPE']])(
  'it exits 255 when impd faults with an exit of no code and the signal %p',
  async (signal) => {
    const peer = buildStubExecPeer((link, message) => {
      if (message.type === 'start') {
        link.send({ type: 'started', pid: 7 });
        link.send({ type: 'exit', code: null, signal });
      }
    });

    const errors: string[] = [];

    const code = await runExec(
      { host: null, name: 'box', argv: ['cmd'], tty: false },
      {
        env: { IMP_URL: 'http://impd.test', IMP_TOKEN: 'root-token' },
        stdin: new PassThrough(),
        writeOutput: () => {},
        printError: (line) => {
          errors.push(line);
        },
        connect: peer.connect,
      },
    );

    expect(code).toBe(255);
    expect(errors).toStrictEqual(['impz: impd reported an exit with no code and no known signal']);
  },
);

test('it sends stdin once when impd faults by repeating started', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 7 });
      link.send({ type: 'started', pid: 7 });
    }

    if (message.type === 'stdin_eof') {
      link.send({ type: 'exit', code: 0, signal: null });
    }
  });

  const stdin = new PassThrough();

  stdin.end('typed');

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: 'http://impd.test', IMP_TOKEN: 'root-token' },
      stdin,
      writeOutput: () => {},
      printError: () => {},
      connect: peer.connect,
    },
  );

  expect(code).toBe(0);

  expect(peer.received).toStrictEqual([
    { type: 'start', name: 'box', argv: ['cmd'], tty: false },
    { type: 'stdin', text: 'typed', bytes: 5 },
    { type: 'stdin_eof' },
  ]);
});

test('it exits 255 for an IMP_URL that is not an http URL', async () => {
  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: 'localhost:7070', IMP_TOKEN: 'root-token' },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
    },
  );

  expect(code).toBe(255);
  expect(errors).toStrictEqual(['impz: IMP_URL is not an http(s) URL: localhost:7070']);
});

test('it exits 127 when the command cannot start', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'EXEC_FAILED', message: 'cmd: not found' },
      }),
    );
  });

  const code = await runExec({ host: null, name: 'box', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(127);
  expect(ctx.errors).toStrictEqual(['impz: EXEC_FAILED: cmd: not found']);
});

test('it exits 255 and names the refusal for an imp impd does not have', async () => {
  const ctx = await setupTest();
  const code = await runExec({ host: null, name: 'nope', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(255);

  expect(ctx.errors as unknown).toStrictEqual([
    expect.stringMatching(/^impz: NOT_FOUND: .*nope/u) as unknown,
  ]);
});

test('it explains INNER_DOWN and exits 255', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'INNER_DOWN', message: 'the inner container is down' },
      }),
    );
  });

  const code = await runExec({ host: null, name: 'box', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(255);

  expect(ctx.errors).toStrictEqual([
    'impz: INNER_DOWN: the inner container is down (the container in the imp starts again on its own; impz stop and impz start, or impz restore, bring it back)',
  ]);
});

test('it ends the session and closes the socket when impd faults with a frame on an unknown channel', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 7 });
      link.sendFrame(9, 'x');
    }
  });

  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: 'http://impd.test', IMP_TOKEN: 'root-token' },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
      connect: peer.connect,
    },
  );

  expect(code).toBe(255);

  expect(errors as unknown).toStrictEqual([
    expect.stringMatching(/^impz: bad message from impd: /u) as unknown,
  ]);

  await expect(peer.closed).toResolve();
});

test('it ends the session and closes the socket when impd faults with text that is not JSON', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 7 });
      link.sendText('{not json');
    }
  });

  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: 'http://impd.test', IMP_TOKEN: 'root-token' },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
      connect: peer.connect,
    },
  );

  expect(code).toBe(255);

  expect(errors as unknown).toStrictEqual([
    expect.stringMatching(/^impz: bad message from impd: /u) as unknown,
  ]);

  await expect(peer.closed).toResolve();
});

test('it ends the session and closes the socket when impd faults with a frame on the stdin channel', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 7 });
      link.sendFrame(EXEC_CHANNELS.stdin, 'x');
    }
  });

  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: 'http://impd.test', IMP_TOKEN: 'root-token' },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
      connect: peer.connect,
    },
  );

  expect(code).toBe(255);

  expect(errors as unknown).toStrictEqual([
    expect.stringMatching(/^impz: bad message from impd: /u) as unknown,
  ]);

  await expect(peer.closed).toResolve();
});

test('it exits 255 when the agent connection drops after started without an exit', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
  });

  const code = await runExec({ host: null, name: 'box', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(255);
  expect(ctx.errors).toStrictEqual(['impz: the agent connection closed before the process exited']);
});

test('it exits 255 and gives the reason when impd faults by closing after started without an exit', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 7 });
      link.close(1011, 'agent gone');
    }
  });

  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: 'http://impd.test', IMP_TOKEN: 'root-token' },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
      connect: peer.connect,
    },
  );

  expect(code).toBe(255);
  expect(errors).toStrictEqual(['impz: exec connection closed (agent gone)']);
});

test('it exits 255 with the token hint when impd rejects the token', async () => {
  const ctx = await setupTest();

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    { ...ctx.io, env: { IMP_URL: ctx.url, IMP_TOKEN: 'wrong-token' } },
  );

  expect(code).toBe(255);

  expect(ctx.errors as unknown).toStrictEqual([
    expect.stringMatching(/^impz: unauthorized: set IMP_TOKEN/u) as unknown,
  ]);
});

test('it exits 255 and names the address when nothing listens there', async () => {
  // a port that a probe held a moment ago and nothing holds now
  const port = findFreePorts(1).take();
  const url = `http://127.0.0.1:${String(port)}`;
  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: url, IMP_TOKEN: 'root-token' },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
    },
  );

  expect(code).toBe(255);
  expect(errors).toStrictEqual([`impz: cannot reach impd at ${url} (the connection failed)`]);
});

test('it keeps the IMP_URL path prefix of an impd behind a proxy', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
  });

  // a reverse proxy that serves impd under /imp, and nothing outside it
  const proxy = startStubPrefixProxy(ctx.stack, { target: ctx.url, prefix: '/imp' });

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    { ...ctx.io, env: { IMP_URL: proxy.url, IMP_TOKEN: ctx.rootToken } },
  );

  expect(code).toBe(0);
  expect(proxy.paths).toStrictEqual(['/imp/exec']);
});

test('it exits 141 quietly and stops the command when its output goes away', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agentClosed = Promise.withResolvers<void>();

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.on('close', () => {
      agentClosed.resolve();
    });

    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('out')));
  });

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      ...ctx.io,
      writeOutput: () => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
    },
  );

  expect(code).toBe(141);
  expect(ctx.errors).toBeEmpty();

  await expect(agentClosed.promise).toResolve();
});

test('it exits 255 and names the failure when an output write fails other than by a closed pipe', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('out')));
  });

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      ...ctx.io,
      writeOutput: () => {
        throw Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' });
      },
    },
  );

  expect(code).toBe(255);
  expect(ctx.errors).toStrictEqual(['impz: write ENOSPC']);
});

// on the exec peer: real impd sends detached only after started, and every
// started reopens the window to attach again; only impd's protocol fault of a
// detached before started ends a session as lost once that window is over
test('it exits 255 and says the connection was lost once the window to attach again is over, after impd sends a detached before started', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 7, session: 'main', created: true });
    }

    link.send({ type: 'detached', reason: 'lost' });
  });

  const terminal = buildStubTerminal();
  const errors: string[] = [];

  const code = await runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    {
      env: { IMP_URL: 'http://impd.test', IMP_TOKEN: 'root-token' },
      stdin: terminal.stdin,
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
      connect: peer.connect,
      isAttachedElsewhere: () => Promise.resolve(false),

      // a window that is over by the time the first attach fails
      reattachWindowMs: 0,
      wait: () => Promise.resolve(),
    },
  );

  expect(code).toBe(255);
  expect(peer.received.map((message) => message.type)).toStrictEqual(['start', 'attach']);

  expect(errors).toStrictEqual([
    'impz: detached, the connection was lost: session main (impz attach box main)',
  ]);
});

test('it pauses stdin while the socket buffers more than the high-water mark', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
      }
    },
  );

  const congested = { socket: null as ReturnType<typeof buildStubCongestedSocket> | null };

  void runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      ...ctx.io,
      connect: (url, headers) => {
        const stub = buildStubCongestedSocket(new WebSocket(url, { headers: { ...headers } }));

        // the CLI is still running when the test ends; its socket goes first
        ctx.stack.defer(() => {
          stub.socket.close();
        });

        congested.socket = stub;

        return stub.socket;
      },
    },
  );

  await waitFor(() => {
    expect(agent.received).toHaveLength(1);
  });

  invariant(congested.socket);

  congested.socket.queued.bytes = 2 * 1_048_576;

  ctx.stdin.write('first');

  await waitFor(() => {
    expect(agent.received).toHaveLength(2);
  });

  expect(ctx.stdin.isPaused()).toBeTrue();
});

test('it resumes stdin once the socket buffer drains', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
      }

      if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
        socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
      }
    },
  );

  const congested = { socket: null as ReturnType<typeof buildStubCongestedSocket> | null };

  const exiting = runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      ...ctx.io,
      connect: (url, headers) => {
        const stub = buildStubCongestedSocket(new WebSocket(url, { headers: { ...headers } }));

        congested.socket = stub;

        return stub.socket;
      },
    },
  );

  await waitFor(() => {
    expect(agent.received).toHaveLength(1);
  });

  invariant(congested.socket);

  congested.socket.queued.bytes = 2 * 1_048_576;

  ctx.stdin.write('first');

  await waitFor(() => {
    expect(ctx.stdin.isPaused()).toBeTrue();
  });

  congested.socket.queued.bytes = 0;

  ctx.stdin.end('second');

  const code = await exiting;

  expect(code).toBe(0);

  expect(
    agent.received
      .filter((frame) => frame.type === FRAME_TYPES.stdin)
      .map((frame) => new TextDecoder().decode(frame.payload)),
  ).toStrictEqual(['first', 'second']);
});

test('it starts a named session and detaches on the detach key without a signal', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agentClosed = Promise.withResolvers<void>();

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.on('close', () => {
          agentClosed.resolve();
        });

        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
        );
      }
    },
  );

  const terminal = buildStubTerminal();

  terminal.stdin.write('ls\u001Dmore');

  const code = await runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    { ...ctx.io, stdin: terminal.stdin },
  );

  await agentClosed.promise;

  const [request, ...rest] = agent.received;

  invariant(request);

  expect(code).toBe(0);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'exec',
    argv: ['sh'],
    tty: true,
    session: 'main',
  });

  expect(rest.map((frame) => [frame.type, new TextDecoder().decode(frame.payload)])).toStrictEqual([
    [FRAME_TYPES.stdin, 'ls'],
  ]);

  expect(terminal.modes).toStrictEqual([true, false]);
  expect(ctx.output.at(-1)).toStartWith('1:');
  expect(ctx.output.at(-1)).toInclude('\u001B[>4;0m');
  expect(ctx.errors).toStrictEqual(['impz: detached from session main (impz attach box main)']);
});

test('it detaches on the detach key in its kitty form', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agentClosed = Promise.withResolvers<void>();

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.on('close', () => {
          agentClosed.resolve();
        });

        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
        );
      }
    },
  );

  const terminal = buildStubTerminal();

  terminal.stdin.write('ls\u001B[93;5umore');

  const code = await runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    { ...ctx.io, stdin: terminal.stdin },
  );

  await agentClosed.promise;

  expect(code).toBe(0);

  expect(
    agent.received.slice(1).map((frame) => [frame.type, new TextDecoder().decode(frame.payload)]),
  ).toStrictEqual([[FRAME_TYPES.stdin, 'ls']]);
});

test('it clears the screen before the replay of a session it attaches to', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: false }));
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('replay')));
    socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
  });

  const terminal = buildStubTerminal();

  const code = await runExec(
    {
      host: null,
      name: 'box',
      argv: [],
      tty: true,
      session: { name: 'main', attachOnly: true, detachKey: 0x1d },
    },
    { ...ctx.io, stdin: terminal.stdin },
  );

  const [request] = agent.received;

  invariant(request);

  expect(code).toBe(0);
  expect(decodeJsonPayload(request)).toStrictEqual({ op: 'session.attach', session: 'main' });
  expect(ctx.output.slice(0, 2)).toStrictEqual(['1:\u001B[H\u001B[2J', '1:replay']);
});

test('it attaches again by itself when impd loses the agent connection of a session', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request, frames) => {
      if (frames.length > 1) {
        return;
      }

      const op = z.looseObject({ op: z.string() }).parse(decodeJsonPayload(request)).op;

      if (op === 'activity') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            tcp_established: 0,
            exec_sessions: 0,
            load1: 0,
            sessions: [],
          }),
        );
      } else if (op === 'exec') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
        );
      } else {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: false }),
        );

        socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 4, signal: 0 }));
      }
    },
  );

  const terminal = buildStubTerminal();

  const code = await runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    { ...ctx.io, stdin: terminal.stdin, wait: () => Promise.resolve() },
  );

  expect(code).toBe(4);

  expect(
    agent.received
      .filter((frame) => frame.type === FRAME_TYPES.request)
      .map((frame) => z.looseObject({ op: z.string() }).parse(decodeJsonPayload(frame)).op),
  ).toStrictEqual(['exec', 'activity', 'session.attach']);

  expect(ctx.output.join('')).toInclude('lost the connection to session main; attaching again');
});

test('it attaches again by itself when the terminal fell behind', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request, frames) => {
      if (frames.length > 1) {
        return;
      }

      const op = z.looseObject({ op: z.string() }).parse(decodeJsonPayload(request)).op;

      if (op === 'activity') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            tcp_established: 0,
            exec_sessions: 0,
            load1: 0,
            sessions: [],
          }),
        );
      } else if (op === 'exec') {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
        );

        socket.write(encodeJsonFrame(FRAME_TYPES.detached, { reason: 'slow' }));
      } else {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: false }),
        );

        socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 4, signal: 0 }));
      }
    },
  );

  const terminal = buildStubTerminal();

  const code = await runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    { ...ctx.io, stdin: terminal.stdin, wait: () => Promise.resolve() },
  );

  expect(code).toBe(4);
  expect(ctx.output.join('')).toInclude('lost the connection to session main; attaching again');
});

test('it attaches again by itself when impd restarts under a session', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request, frames) => {
      if (frames.length > 1) {
        return;
      }

      const op = z.looseObject({ op: z.string() }).parse(decodeJsonPayload(request)).op;

      if (op === 'activity') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            tcp_established: 0,
            exec_sessions: 0,
            load1: 0,
            sessions: [],
          }),
        );
      } else if (op === 'exec') {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
        );
      } else {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: false }),
        );

        socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 4, signal: 0 }));
      }
    },
  );

  const terminal = buildStubTerminal();

  // the CLI's pause before it attaches again: impd comes back on its port
  const wait = (): Promise<void> => {
    ctx.impd.api.app.listen({ port: ctx.port, hostname: '127.0.0.1' });

    return Promise.resolve();
  };

  const exiting = runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    { ...ctx.io, stdin: terminal.stdin, wait },
  );

  // the session started: the terminal went raw
  await waitFor(() => {
    expect(terminal.modes).toStrictEqual([true]);
  });

  await ctx.impd.api.app.stop(true);

  const code = await exiting;

  expect(code).toBe(4);

  expect(
    agent.received
      .filter((frame) => frame.type === FRAME_TYPES.request)
      .map((frame) => z.looseObject({ op: z.string() }).parse(decodeJsonPayload(frame)).op),
  ).toStrictEqual(['exec', 'activity', 'session.attach']);

  expect(ctx.output.join('')).toInclude('lost the connection to session main; attaching again');
});

test('it sends keys typed while it attaches again to the new session', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request, frames) => {
      const op = z.looseObject({ op: z.string() }).parse(decodeJsonPayload(request)).op;

      if (op === 'activity') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            tcp_established: 0,
            exec_sessions: 0,
            load1: 0,
            sessions: [],
          }),
        );
      } else if (op === 'exec') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
        );
      } else if (frames.length === 1) {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: false }),
        );
      } else {
        socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
      }
    },
  );

  const terminal = buildStubTerminal();
  const pause = Promise.withResolvers<void>();

  const exiting = runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    { ...ctx.io, stdin: terminal.stdin, wait: () => pause.promise },
  );

  await waitFor(() => {
    expect(ctx.output.join('')).toInclude('attaching again');
  });

  terminal.stdin.write('typed');
  pause.resolve();

  const code = await exiting;

  expect(code).toBe(0);

  expect(
    agent.received
      .filter((frame) => frame.type === FRAME_TYPES.stdin)
      .map((frame) => new TextDecoder().decode(frame.payload)),
  ).toStrictEqual(['typed']);

  expect(ctx.output.join('')).toInclude('impz: attached again to session main');
});

test.each([['\u001D'], ['\u001B[93;5u'], ['\u001B[27;5;93~']])(
  'it detaches on the detach key %p while it attaches again',
  async (key) => {
    const ctx = await setupTest();

    const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

    await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

    await createImage(ctx.db, image);

    const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

    await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
      socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }));
    });

    const terminal = buildStubTerminal();

    const exiting = runExec(
      {
        host: null,
        name: 'box',
        argv: ['sh'],
        tty: true,
        session: { name: 'main', attachOnly: false, detachKey: 0x1d },
      },

      // the pause before the next try never ends
      { ...ctx.io, stdin: terminal.stdin, wait: () => new Promise<void>(() => {}) },
    );

    await waitFor(() => {
      expect(ctx.output.join('')).toInclude('attaching again');
    });

    terminal.stdin.write(`typed${key}`);

    const code = await exiting;

    expect(code).toBe(0);
    expect(ctx.errors).toStrictEqual(['impz: detached from session main (impz attach box main)']);
  },
);

test('it gives up with 130 on ctrl-c while it attaches again', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }));
  });

  const terminal = buildStubTerminal();

  const exiting = runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },

    // the pause before the next try never ends
    { ...ctx.io, stdin: terminal.stdin, wait: () => new Promise<void>(() => {}) },
  );

  await waitFor(() => {
    expect(ctx.output.join('')).toInclude('attaching again');
  });

  terminal.stdin.write('\u0003');

  const code = await exiting;

  expect(code).toBe(130);
});

test('it exits 254 without attaching again once another client attached', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const op = z.looseObject({ op: z.string() }).parse(decodeJsonPayload(request)).op;

      if (op === 'activity') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            tcp_established: 0,
            exec_sessions: 1,
            load1: 0,
            sessions: [
              {
                name: 'main',
                pid: 7,
                argv: ['sh'],
                state: 'running',
                attached: true,
                cols: 80,
                rows: 24,
                started_unix_ms: 0,
              },
            ],
          }),
        );
      } else {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
        );
      }
    },
  );

  const terminal = buildStubTerminal();

  const code = await runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    { ...ctx.io, stdin: terminal.stdin, wait: () => Promise.resolve() },
  );

  expect(code).toBe(254);

  expect(
    agent.received
      .filter((frame) => frame.type === FRAME_TYPES.request)
      .map((frame) => z.looseObject({ op: z.string() }).parse(decodeJsonPayload(frame)).op),
  ).toStrictEqual(['exec', 'activity']);

  expect(ctx.errors).toStrictEqual([
    'impz: another client attached to session main (impz attach box main)',
  ]);
});

test('it exits 254 without attaching again when another client takes the session over', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }));
    socket.write(encodeJsonFrame(FRAME_TYPES.detached, { reason: 'taken_over' }));
  });

  const terminal = buildStubTerminal();

  const code = await runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    { ...ctx.io, stdin: terminal.stdin, wait: () => Promise.resolve() },
  );

  expect(code).toBe(254);
  expect(agent.received).toHaveLength(1);

  expect(ctx.errors).toStrictEqual([
    'impz: another client attached to session main (impz attach box main)',
  ]);
});

test('it doubles the pause before each try, up to 8 s, while impd stays down under a session', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // an agent whose session runs on until impd goes away
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
        );
      }
    },
  );

  const terminal = buildStubTerminal();
  const clock = { nowMs: Date.UTC(2026, 0, 1) };
  const pauses: number[] = [];

  const exiting = runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    {
      ...ctx.io,
      stdin: terminal.stdin,
      isAttachedElsewhere: () => Promise.resolve(false),
      reattachWindowMs: 20_000,
      now: () => clock.nowMs,
      wait: (ms) => {
        pauses.push(ms);

        clock.nowMs += ms;

        return Promise.resolve();
      },
    },
  );

  // the session started: the terminal went raw
  await waitFor(() => {
    expect(terminal.modes).toStrictEqual([true]);
  });

  await ctx.impd.api.app.stop(true);

  await exiting;

  expect(pauses).toStrictEqual([1000, 2000, 4000, 8000, 8000]);
  expect(agent.received).toHaveLength(1);
});

test('it fails with the last reason once the window to attach again is over, while impd stays down under a session', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // an agent whose session runs on until impd goes away
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
        );
      }
    },
  );

  const terminal = buildStubTerminal();
  const clock = { nowMs: Date.UTC(2026, 0, 1) };
  const errors: string[] = [];

  const exiting = runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    {
      ...ctx.io,
      stdin: terminal.stdin,
      printError: (line) => {
        errors.push(line);
      },
      isAttachedElsewhere: () => Promise.resolve(false),
      reattachWindowMs: 1500,
      now: () => clock.nowMs,
      wait: (ms) => {
        clock.nowMs += ms;

        return Promise.resolve();
      },
    },
  );

  // the session started: the terminal went raw
  await waitFor(() => {
    expect(terminal.modes).toStrictEqual([true]);
  });

  await ctx.impd.api.app.stop(true);

  const code = await exiting;

  expect(code).toBe(255);
  expect(agent.received).toHaveLength(1);
  expect(errors).toStrictEqual([`impz: cannot reach impd at ${ctx.url} (the connection failed)`]);
});

test('it sends the detach key as input to a plain exec and never attaches it again', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
      } else {
        socket.destroy();
      }
    },
  );

  const terminal = buildStubTerminal();

  terminal.stdin.write('\u001D');

  const code = await runExec(
    { host: null, name: 'box', argv: ['sh'], tty: true },
    { ...ctx.io, stdin: terminal.stdin, wait: () => Promise.resolve() },
  );

  expect(code).toBe(255);

  expect(
    agent.received.map((frame) => [frame.type, new TextDecoder().decode(frame.payload)]) as unknown,
  ).toStrictEqual([
    [FRAME_TYPES.request, expect.any(String) as unknown],
    [FRAME_TYPES.stdin, '\u001D'],
  ]);
});

test('it ends the CLI at once on a signal before impd answers the start, without sending it', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the agent never answers the start, as when impd hangs waking the imp
  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, () => {});

  const cli = startCli({
    args: ['exec', 'box', '--', 'sleep', '60'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  ctx.stack.defer(() => {
    cli.kill();
  });

  // a cold bun start on a loaded machine can take seconds
  await waitFor(
    () => {
      expect(agent.received).toHaveLength(1);
    },
    { timeoutMs: 20_000 },
  );

  cli.kill('SIGTERM');

  const code = await cli.exited;

  const [request] = agent.received;

  invariant(request);

  expect(code).toBe(143);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'exec',
    argv: ['sleep', '60'],
    tty: false,
  });

  expect(agent.received).toHaveLength(1);
}, 20_000);

test('it sends the first SIGINT to the command and ends the CLI on the second', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the command ignores SIGINT, so only the second one ends anything
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
      }
    },
  );

  const cli = startCli({
    args: ['exec', 'box', '--', 'sleep', '60'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  ctx.stack.defer(() => {
    cli.kill();
  });

  // stdin is /dev/null, so its end follows started; a cold bun start on a
  // loaded machine can take seconds
  await waitFor(
    () => {
      expect(agent.received).toPartiallyContain({ type: FRAME_TYPES.stdinEof });
    },
    { timeoutMs: 20_000 },
  );

  cli.kill('SIGINT');

  await waitFor(() => {
    expect(agent.received).toPartiallyContain({ type: FRAME_TYPES.signal });
  });

  cli.kill('SIGINT');

  const code = await cli.exited;

  expect(code).toBe(130);

  expect(
    agent.received
      .filter((frame) => frame.type === FRAME_TYPES.signal)
      .map((frame) => decodeJsonPayload(frame)),
  ).toStrictEqual([{ signal: 2 }]);
}, 20_000);

test('it takes the terminal out of raw mode when an output write calls process.exit', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('out')));
  });

  // a process of its own, for process.exit: the stub terminal on stdin, and
  // output that prints its modes, then exits; the exit's terminal reset
  // writes output once more
  const script = `
      import { runExec } from ${JSON.stringify(join(import.meta.dir, 'exec-client.ts'))};
      import { buildStubTerminal } from ${JSON.stringify(join(import.meta.dir, 'test-utils', 'build-stub-terminal.ts'))};

      const terminal = buildStubTerminal();

      await runExec({ host: null, name: 'box', argv: ['sh'], tty: true }, {
        env: process.env,
        stdin: terminal.stdin,
        writeOutput: () => {
          console.error(JSON.stringify(terminal.modes));
          process.exit(3);
        },
      });
    `;

  // HOME is the test's temp dir, so the child never reads the developer's config
  const child = Bun.spawn(['bun', '-e', script], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: ctx.dataDir,
      IMP_URL: ctx.url,
      IMP_TOKEN: ctx.rootToken,
    },
    stdin: 'ignore',
    stderr: 'pipe',
  });

  ctx.stack.defer(() => {
    child.kill();
  });

  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  expect(code).toBe(3);
  expect(stderr).toBe('[true]\n[true,false]\n');
}, 20_000);
