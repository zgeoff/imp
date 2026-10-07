import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EXEC_CHANNELS } from '@imp/api';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
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
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import { runExec } from './exec-client';
import type { ExecIo } from './exec-client';
import { buildStubCongestedSocket } from './test-utils/build-stub-congested-socket';
import { buildStubTerminal } from './test-utils/build-stub-terminal';
import { startCli } from './test-utils/start-cli';
import { startStubImpd } from './test-utils/start-stub-impd';

// impd, booted on stand-ins and listening on a loopback port, with a
// running imp `box` whose agent each test starts on `vsockPath`
async function setupTest() {
  await using stack = new AsyncDisposableStack();

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

  const paths = buildImpPaths(dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent that runs sessions, tools and outer execs; the stub VMM records
  // an older one
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  const stdin = new PassThrough();

  const output: string[] = [];
  const errors: string[] = [];

  const io: ExecIo = {
    env: { IMP_URL: url, IMP_TOKEN: 'root-token' },
    stdin,
    writeOutput: (fd, data) => {
      output.push(`${String(fd)}:${new TextDecoder().decode(data)}`);
    },
    printError: (line) => {
      errors.push(line);
    },
  };

  const owned = stack.move();

  return {
    url,
    vsockPath: paths.vsockSocket,
    io,
    stdin,
    output,
    errors,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it streams output and stdin and exits with the command’s code', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket, _request, frames) => {
    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
      socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('out')));
      socket.write(encodeFrame(FRAME_TYPES.stderr, new TextEncoder().encode('err')));
    }

    if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
      socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 3, signal: 0 }));
    }
  });

  onTestFinished(agent.close);

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
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
  });

  onTestFinished(agent.close);

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
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
  });

  onTestFinished(agent.close);

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false, require: ['broker'] },
    ctx.io,
  );

  expect(code).toBe(255);

  expect(ctx.errors as unknown).toStrictEqual([
    expect.stringMatching(
      /^imp: PRECONDITION_FAILED: the broker is not ready for this exec: .*no grant/u,
    ) as unknown,
  ]);

  expect(agent.received).toBeEmpty();
});

test.each([
  ['SIGKILL', 9, 137],
  ['a numbered signal', 34, 162],
])('it exits 128 + n when %s ends the command', async (_name, signal, expected) => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal }));
  });

  onTestFinished(agent.close);

  const code = await runExec({ host: null, name: 'box', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(expected);
});

test.each([[null], ['SIGNOPE']])(
  'it exits 255 when impd faults with an exit of no code and the signal %p',
  async (signal) => {
    using impd = startStubImpd({
      onExec: (peer, message) => {
        if (message.type === 'start') {
          peer.send({ type: 'started', pid: 7 });
          peer.send({ type: 'exit', code: null, signal });
        }
      },
    });

    const errors: string[] = [];

    const code = await runExec(
      { host: null, name: 'box', argv: ['cmd'], tty: false },
      {
        env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
        stdin: new PassThrough(),
        writeOutput: () => {},
        printError: (line) => {
          errors.push(line);
        },
      },
    );

    expect(code).toBe(255);
    expect(errors).toStrictEqual(['imp: impd reported an exit with no code and no known signal']);
  },
);

test('it sends stdin once when impd faults by repeating started', async () => {
  using impd = startStubImpd({
    onExec: (peer, message) => {
      if (message.type === 'start') {
        peer.send({ type: 'started', pid: 7 });
        peer.send({ type: 'started', pid: 7 });
      }

      if (message.type === 'stdin_eof') {
        peer.send({ type: 'exit', code: 0, signal: null });
      }
    },
  });

  const stdin = new PassThrough();

  stdin.end('typed');

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin,
      writeOutput: () => {},
      printError: () => {},
    },
  );

  expect(code).toBe(0);

  expect(impd.received).toStrictEqual([
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
  expect(errors).toStrictEqual(['imp: IMP_URL is not an http(s) URL: localhost:7070']);
});

test('it exits 127 when the command cannot start', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'EXEC_FAILED', message: 'cmd: not found' },
      }),
    );
  });

  onTestFinished(agent.close);

  const code = await runExec({ host: null, name: 'box', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(127);
  expect(ctx.errors).toStrictEqual(['imp: EXEC_FAILED: cmd: not found']);
});

test('it exits 255 and names the refusal for an imp impd does not have', async () => {
  await using ctx = await setupTest();

  const code = await runExec({ host: null, name: 'nope', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(255);

  expect(ctx.errors as unknown).toStrictEqual([
    expect.stringMatching(/^imp: NOT_FOUND: .*nope/u) as unknown,
  ]);
});

test('it explains INNER_DOWN and exits 255', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'INNER_DOWN', message: 'the inner container is down' },
      }),
    );
  });

  onTestFinished(agent.close);

  const code = await runExec({ host: null, name: 'box', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(255);

  expect(ctx.errors).toStrictEqual([
    'imp: INNER_DOWN: the inner container is down (the container in the imp starts again on its own; imp stop and imp start, or imp restore, bring it back)',
  ]);
});

test('it ends the session and closes the socket when impd faults with a frame on an unknown channel', async () => {
  using impd = startStubImpd({
    onExec: (peer, message) => {
      if (message.type === 'start') {
        peer.send({ type: 'started', pid: 7 });
        peer.sendFrame(9, 'x');
      }
    },
  });

  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
    },
  );

  expect(code).toBe(255);

  expect(errors as unknown).toStrictEqual([
    expect.stringMatching(/^imp: bad message from impd: /u) as unknown,
  ]);

  await expect(impd.closed).toResolve();
});

test('it ends the session and closes the socket when impd faults with text that is not JSON', async () => {
  using impd = startStubImpd({
    onExec: (peer, message) => {
      if (message.type === 'start') {
        peer.send({ type: 'started', pid: 7 });
        peer.sendText('{not json');
      }
    },
  });

  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
    },
  );

  expect(code).toBe(255);

  expect(errors as unknown).toStrictEqual([
    expect.stringMatching(/^imp: bad message from impd: /u) as unknown,
  ]);

  await expect(impd.closed).toResolve();
});

test('it ends the session and closes the socket when impd faults with a frame on the stdin channel', async () => {
  using impd = startStubImpd({
    onExec: (peer, message) => {
      if (message.type === 'start') {
        peer.send({ type: 'started', pid: 7 });
        peer.sendFrame(EXEC_CHANNELS.stdin, 'x');
      }
    },
  });

  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
    },
  );

  expect(code).toBe(255);

  expect(errors as unknown).toStrictEqual([
    expect.stringMatching(/^imp: bad message from impd: /u) as unknown,
  ]);

  await expect(impd.closed).toResolve();
});

test('it exits 255 when the agent connection drops after started without an exit', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
  });

  onTestFinished(agent.close);

  const code = await runExec({ host: null, name: 'box', argv: ['cmd'], tty: false }, ctx.io);

  expect(code).toBe(255);
  expect(ctx.errors).toStrictEqual(['imp: the agent connection closed before the process exited']);
});

test('it exits 255 and gives the reason when impd faults by closing after started without an exit', async () => {
  using impd = startStubImpd({
    onExec: (peer, message) => {
      if (message.type === 'start') {
        peer.send({ type: 'started', pid: 7 });
        peer.close(1011, 'agent gone');
      }
    },
  });

  const errors: string[] = [];

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
    },
  );

  expect(code).toBe(255);
  expect(errors).toStrictEqual(['imp: exec connection closed (agent gone)']);
});

test('it exits 255 with the token hint when impd rejects the token', async () => {
  await using ctx = await setupTest();

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    { ...ctx.io, env: { IMP_URL: ctx.url, IMP_TOKEN: 'wrong-token' } },
  );

  expect(code).toBe(255);

  expect(ctx.errors as unknown).toStrictEqual([
    expect.stringMatching(/^imp: unauthorized: set IMP_TOKEN/u) as unknown,
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

  expect(errors as unknown).toStrictEqual([
    expect.stringMatching(/^imp: cannot reach impd at http:\/\/127\.0\.0\.1:\d+ \(/u) as unknown,
  ]);
});

test('it keeps the IMP_URL path prefix of an impd behind a proxy', async () => {
  using impd = startStubImpd({
    prefix: '/imp',
    onExec: (peer, message) => {
      if (message.type === 'start') {
        peer.send({ type: 'started', pid: 7 });
        peer.send({ type: 'exit', code: 0, signal: null });
      }
    },
  });

  const code = await runExec(
    { host: null, name: 'box', argv: ['cmd'], tty: false },
    {
      env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin: new PassThrough(),
      writeOutput: () => {},
      printError: () => {},
    },
  );

  expect(code).toBe(0);
  expect(impd.paths).toStrictEqual(['/imp/exec']);
});

test('it exits 141 quietly and stops the command when its output goes away', async () => {
  await using ctx = await setupTest();

  const agentClosed = Promise.withResolvers<void>();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.on('close', () => {
      agentClosed.resolve();
    });

    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('out')));
  });

  onTestFinished(agent.close);

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

test('it pauses stdin while the socket buffers more than the high-water mark', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket, _request, frames) => {
    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    }
  });

  onTestFinished(agent.close);

  const congested = { socket: null as ReturnType<typeof buildStubCongestedSocket> | null };

  void runExec(
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

  onTestFinished(() => {
    congested.socket?.socket.close();
  });

  congested.socket.queued.bytes = 2 * 1_048_576;

  ctx.stdin.write('first');

  await waitFor(() => {
    expect(agent.received).toHaveLength(2);
  });

  expect(ctx.stdin.isPaused()).toBeTrue();
});

test('it resumes stdin once the socket buffer drains', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket, _request, frames) => {
    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    }

    if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
      socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
    }
  });

  onTestFinished(agent.close);

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
  await using ctx = await setupTest();

  const agentClosed = Promise.withResolvers<void>();

  const agent = await startStubAgent(ctx.vsockPath, (socket, _request, frames) => {
    if (frames.length === 1) {
      socket.on('close', () => {
        agentClosed.resolve();
      });

      socket.write(
        encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
      );
    }
  });

  onTestFinished(agent.close);

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
  expect(ctx.errors).toStrictEqual(['imp: detached from session main (imp attach box main)']);
});

test('it detaches on the detach key in its kitty form', async () => {
  await using ctx = await setupTest();

  const agentClosed = Promise.withResolvers<void>();

  const agent = await startStubAgent(ctx.vsockPath, (socket, _request, frames) => {
    if (frames.length === 1) {
      socket.on('close', () => {
        agentClosed.resolve();
      });

      socket.write(
        encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }),
      );
    }
  });

  onTestFinished(agent.close);

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
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: false }));
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('replay')));
    socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
  });

  onTestFinished(agent.close);

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
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket, request, frames) => {
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
      socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }));
    } else {
      socket.write(
        encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: false }),
      );

      socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 4, signal: 0 }));
    }
  });

  onTestFinished(agent.close);

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
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket, request, frames) => {
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
  });

  onTestFinished(agent.close);

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
  using impd = startStubImpd({
    answers: { 'sessions/list': [] },
    onExec: (peer, message) => {
      if (message.type === 'start') {
        peer.send({ type: 'started', pid: 7, session: 'main', created: true });
        peer.close(1012, 'impd is restarting');
      }

      if (message.type === 'attach') {
        peer.send({ type: 'started', pid: 7, session: 'main', created: false });
        peer.send({ type: 'exit', code: 4, signal: null });
      }
    },
  });

  const terminal = buildStubTerminal();
  const output: string[] = [];

  const code = await runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    {
      env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin: terminal.stdin,
      writeOutput: (_fd, data) => {
        output.push(new TextDecoder().decode(data));
      },
      printError: () => {},
      wait: () => Promise.resolve(),
    },
  );

  expect(code).toBe(4);
  expect(impd.received.map((message) => message.type)).toStrictEqual(['start', 'attach']);
  expect(output.join('')).toInclude('lost the connection to session main; attaching again');
});

test('it sends keys typed while it attaches again to the new session', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket, request, frames) => {
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
      socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }));
    } else if (frames.length === 1) {
      socket.write(
        encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: false }),
      );
    } else {
      socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
    }
  });

  onTestFinished(agent.close);

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

  expect(ctx.output.join('')).toInclude('imp: attached again to session main');
});

test.each([['\u001D'], ['\u001B[93;5u'], ['\u001B[27;5;93~']])(
  'it detaches on the detach key %p while it attaches again',
  async (key) => {
    await using ctx = await setupTest();

    const agent = await startStubAgent(ctx.vsockPath, (socket) => {
      socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }));
    });

    onTestFinished(agent.close);

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
    expect(ctx.errors).toStrictEqual(['imp: detached from session main (imp attach box main)']);
  },
);

test('it gives up with 130 on ctrl-c while it attaches again', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }));
  });

  onTestFinished(agent.close);

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
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket, request) => {
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
      socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }));
    }
  });

  onTestFinished(agent.close);

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
    'imp: another client attached to session main (imp attach box main)',
  ]);
});

test('it exits 254 without attaching again when another client takes the session over', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7, session: 'main', created: true }));
    socket.write(encodeJsonFrame(FRAME_TYPES.detached, { reason: 'taken_over' }));
  });

  onTestFinished(agent.close);

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
    'imp: another client attached to session main (imp attach box main)',
  ]);
});

test('it doubles the pause before each try, up to 8 s, when impd faults by closing every attach', async () => {
  using impd = startStubImpd({
    answers: { 'sessions/list': [] },
    onExec: (peer, message) => {
      if (message.type === 'start') {
        peer.send({ type: 'started', pid: 7, session: 'main', created: true });
        peer.send({ type: 'detached', reason: 'lost' });
      }

      if (message.type === 'attach') {
        peer.close(1011, 'no agent');
      }
    },
  });

  const terminal = buildStubTerminal();
  const clock = { nowMs: Date.UTC(2026, 0, 1) };
  const pauses: number[] = [];

  await runExec(
    {
      host: null,
      name: 'box',
      argv: ['sh'],
      tty: true,
      session: { name: 'main', attachOnly: false, detachKey: 0x1d },
    },
    {
      env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin: terminal.stdin,
      writeOutput: () => {},
      printError: () => {},
      reattachWindowMs: 20_000,
      now: () => clock.nowMs,
      wait: (ms) => {
        pauses.push(ms);

        clock.nowMs += ms;

        return Promise.resolve();
      },
    },
  );

  expect(pauses).toStrictEqual([1000, 2000, 4000, 8000, 8000]);
});

test('it fails with the last reason once the window to attach again is over, when impd faults by closing every attach', async () => {
  using impd = startStubImpd({
    answers: { 'sessions/list': [] },
    onExec: (peer, message) => {
      if (message.type === 'start') {
        peer.send({ type: 'started', pid: 7, session: 'main', created: true });
        peer.send({ type: 'detached', reason: 'lost' });
      }

      // the imp does not come back
      if (message.type === 'attach') {
        peer.close(1011, 'no agent');
      }
    },
  });

  const terminal = buildStubTerminal();
  const clock = { nowMs: Date.UTC(2026, 0, 1) };
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
      env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
      stdin: terminal.stdin,
      writeOutput: () => {},
      printError: (line) => {
        errors.push(line);
      },
      reattachWindowMs: 1500,
      now: () => clock.nowMs,
      wait: (ms) => {
        clock.nowMs += ms;

        return Promise.resolve();
      },
    },
  );

  expect(code).toBe(255);
  expect(impd.received.map((message) => message.type)).toStrictEqual(['start', 'attach', 'attach']);
  expect(errors).toStrictEqual(['imp: exec connection closed (no agent)']);
});

test('it sends the detach key as input to a plain exec and never attaches it again', async () => {
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket, _request, frames) => {
    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    } else {
      socket.destroy();
    }
  });

  onTestFinished(agent.close);

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
  // impd never answers the start, as when it hangs waking the imp
  using impd = startStubImpd();

  const cli = startCli({
    args: ['exec', 'box', '--', 'sleep', '60'],
    env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
  });

  // a cold bun start on a loaded machine can take seconds
  await waitFor(
    () => {
      expect(impd.received).toPartiallyContain({ type: 'start' });
    },
    { timeoutMs: 20_000 },
  );

  cli.kill('SIGTERM');

  const code = await cli.exited;

  expect(code).toBe(143);

  expect(impd.received).toStrictEqual([
    { type: 'start', name: 'box', argv: ['sleep', '60'], tty: false },
  ]);
}, 20_000);

test('it sends the first SIGINT to the command and ends the CLI on the second', async () => {
  await using ctx = await setupTest();

  // the command ignores SIGINT, so only the second one ends anything
  const agent = await startStubAgent(ctx.vsockPath, (socket, _request, frames) => {
    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    }
  });

  onTestFinished(agent.close);

  const cli = startCli({
    args: ['exec', 'box', '--', 'sleep', '60'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
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
  await using ctx = await setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }));
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('out')));
  });

  onTestFinished(agent.close);

  // a process of its own, for process.exit: a terminal on stdin that logs
  // its mode, and output that exits
  const script = `
      import { PassThrough } from 'node:stream';
      import { runExec } from ${JSON.stringify(join(import.meta.dir, 'exec-client.ts'))};

      const stdin = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: (mode) => console.error('raw ' + mode),
      });

      await runExec({ host: null, name: 'box', argv: ['sh'], tty: true }, {
        env: process.env,
        stdin,
        writeOutput: () => process.exit(3),
      });
    `;

  const child = Bun.spawn(['bun', '-e', script], {
    env: { PATH: process.env['PATH'] ?? '', IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: 'ignore',
    stderr: 'pipe',
  });

  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  expect(code).toBe(3);
  expect(stderr).toBe('raw true\nraw false\n');
}, 20_000);
