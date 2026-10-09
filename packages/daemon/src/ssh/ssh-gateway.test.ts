import { expect, onTestFinished, test } from 'bun:test';
import { chmodSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/server';
import { Client, utils } from 'ssh2';
import type { PublicKeyAuthMethod } from 'ssh2';
import { AgentError } from '../agent-client/agent-connection';
import { buildAgentOutdatedError } from '../agent-client/agent-outdated';
import { buildMovingError } from '../api-errors';
import { createRevocations } from '../auth/revocations';
import { loadTokenStore } from '../auth/token-store';
import { buildMockImpRecord } from '../test-utils/build-mock-imp-record';
import { buildStubSshBackend } from '../test-utils/build-stub-ssh-backend';
import { createTestDatabase } from '../test-utils/create-test-database';
import { openSshChannel } from '../test-utils/open-ssh-channel';
import { openSshClient } from '../test-utils/open-ssh-client';
import { startStubSshAgent } from '../test-utils/start-stub-ssh-agent';
import { MAX_AGENT_CHANNELS } from './agent-forwarding';
import { createAuthorizedKeys } from './authorized-keys';
import { createEd25519Key } from './host-key';
import { createLoginKeys } from './login-keys';
import { startSshGateway } from './ssh-gateway';
import type { SshGatewayLimits } from './ssh-gateway';

interface GatewayConfig {
  // false: as IMP_SSH_AUTHORIZED_KEYS=false
  readonly fileKeys: boolean;
  readonly limits: Partial<SshGatewayLimits>;
}

// The gateway on loopback over a stub impd, with a real token store, so a
// test can bind keys to tokens, and authorized_keys in an owner-only temp
// dir that the test writes.
async function setupTest(config: Readonly<GatewayConfig>) {
  const dir = await mkdtemp(join(tmpdir(), 'imp-ssh-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o700);

  const keysPath = join(dir, 'authorized_keys');
  const logs: string[] = [];

  const writeLog = (message: string): void => {
    logs.push(message);
  };

  const ssh = buildStubSshBackend();

  const database = await createTestDatabase();

  const authorizedKeys = createAuthorizedKeys(keysPath, writeLog);
  const revocations = createRevocations();

  const tokens = await loadTokenStore({
    db: database.db,

    // the store needs a root secret to load
    rootToken: 'root-secret',
    now: Date.now,
    onRemove: revocations.revoke,
    isFileKey: authorizedKeys.isListed,
  });

  const gateway = await startSshGateway(
    {
      // the gateway cannot start without a host key
      hostKey: createEd25519Key().private,
      keys: createLoginKeys({
        findBound: tokens.findSshKey,
        file: config.fileKeys ? authorizedKeys : null,
      }),
      readRevocation: revocations.readSignal,
      backend: ssh.backend,
      log: writeLog,
      limits: config.limits,
    },
    0,
    '127.0.0.1',
  );

  onTestFinished(() => gateway.stop());

  return { ssh, gateway, logs, keysPath, tokens, revocations };
}

test('it returns an exec command’s output and exit status', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'stdout', data: new TextEncoder().encode('hi\n') });
    run.emit({ type: 'stderr', data: new TextEncoder().encode('err\n') });
    run.emit({ type: 'exit', code: 3, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('echo hi; echo err >&2; exit 3', done);
  });

  const result = await opened.result;

  expect(result).toStrictEqual({
    stdout: 'hi\n',
    stderr: 'err\n',
    code: 3,
    signal: null,
  });
});

test('it runs an exec command with sh -c and no tty', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('echo hi', done);
  });

  await opened.result;

  expect(ctx.ssh.execs[0]?.request).toMatchObject({
    argv: ['/bin/sh', '-c', 'echo hi'],
    tty: false,
  });
});

test('it sets SSH_CONNECTION and SSH_CLIENT to the client’s and the gateway’s addresses', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('env', done);
  });

  await opened.result;

  const port = String(ctx.gateway.port);

  expect(ctx.ssh.execs[0]?.request.env).toIncludeAllMembers([
    expect.stringMatching(
      new RegExp(`^SSH_CONNECTION=127\\.0\\.0\\.1 \\d+ 127\\.0\\.0\\.1 ${port}$`, 'v'),
    ),
    expect.stringMatching(new RegExp(`^SSH_CLIENT=127\\.0\\.0\\.1 \\d+ ${port}$`, 'v')),
  ]);
});

test('it counts a login as ssh activity on the imp until the client leaves', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const whileConnected = ctx.ssh.tracker.count(imp.id, 'ssh');

  client.end();

  await waitFor(() => {
    expect(ctx.ssh.tracker.count(imp.id, 'ssh')).toBe(0);
  });

  expect(whileConnected).toBe(1);
});

test('it passes stdin to the program and closes it at the client’s EOF', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('cat', done);
  });

  opened.channel.end('some input');

  await waitFor(() => {
    expect(ctx.ssh.execs[0]?.stdin).toStrictEqual(['some input', '<eof>']);
  });
});

test('it refuses a login to an imp that does not exist', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const key = createEd25519Key();

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: 'nobody',
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});

test('it refuses a key that authorized_keys does not list', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${createEd25519Key().public}\n`, { mode: 0o600 });

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: createEd25519Key().private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});

test('it never wakes the imp for a refused login', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${createEd25519Key().public}\n`, { mode: 0o600 });

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: createEd25519Key().private,
  });

  expect(login).rejects.toThrow();
  expect(ctx.ssh.stub.wakes).toBe(0);
});

test('it never counts a refused login as activity on the imp', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${createEd25519Key().public}\n`, { mode: 0o600 });

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: createEd25519Key().private,
  });

  expect(login).rejects.toThrow();
  expect(ctx.ssh.tracker.count(imp.id)).toBe(0);
});

test('it refuses a password login', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();

  ctx.ssh.putImp(imp);

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    password: 'secret',
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});

// the client offers a listed public key but signs with another private key
test('it refuses a listed key whose signature does not verify', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const listed = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${listed.public}\n`, { mode: 0o600 });

  const listedKey = utils.parseKey(listed.public);
  const signer = utils.parseKey(createEd25519Key().private);

  if (listedKey instanceof Error || signer instanceof Error) {
    throw new TypeError('a generated key did not parse');
  }

  // ssh2 signs with the signer's private key and sends the listed blob
  const forged = new Proxy(signer, {
    get: (target, property, receiver): unknown =>
      property === 'getPublicSSH'
        ? () => listedKey.getPublicSSH()
        : Reflect.get(target, property, receiver),
  });

  const method: PublicKeyAuthMethod = { type: 'publickey', username: imp.name, key: forged };

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    authHandler: [method],
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
  expect(ctx.ssh.stub.wakes).toBe(0);
});

test('it logs and refuses a login whose imp lookup fails', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.findError = new Error('database is locked');

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
  expect(ctx.logs).toContain('impd: ssh: login check failed: database is locked');
});

test('it drops a client that does not log in within the auth timeout', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: { authTimeoutMs: 50 } });

  const closed = Promise.withResolvers<void>();
  const socket = createConnection({ host: '127.0.0.1', port: ctx.gateway.port });

  onTestFinished(() => {
    socket.destroy();
  });

  socket.on('error', () => {});
  socket.once('close', closed.resolve);

  // reads the server's ident line, so the server's close reaches the socket
  socket.resume();

  await closed.promise;

  expect(socket.destroyed).toBeTrue();
});

test('it drops a connection at once while the pending logins are at the cap', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: { maxUnauthenticated: 1 } });

  const greeted = Promise.withResolvers<void>();
  const first = createConnection({ host: '127.0.0.1', port: ctx.gateway.port });

  onTestFinished(() => {
    first.destroy();
  });

  // the server's ident line shows the first connection is pending
  first.once('data', () => {
    greeted.resolve();
  });

  await greeted.promise;

  const closed = Promise.withResolvers<void>();
  const received: string[] = [];
  const second = createConnection({ host: '127.0.0.1', port: ctx.gateway.port });

  onTestFinished(() => {
    second.destroy();
  });

  second.on('error', () => {});

  second.on('data', (data: Buffer) => {
    received.push(data.toString());
  });

  second.once('close', closed.resolve);

  await closed.promise;

  expect(received).toStrictEqual([]);
  expect(first.destroyed).toBeFalse();
});

test('it drops a connection after the cap of rejected logins', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: { maxAuthFailures: 2 } });

  const imp = buildMockImpRecord();
  const closed = Promise.withResolvers<void>();
  const offered = { attempts: 0 };

  const client = new Client();

  ctx.ssh.putImp(imp);

  onTestFinished(() => {
    client.end();
  });

  client.on('error', () => {});
  client.once('close', closed.resolve);

  // a wrong password each time, until the gateway drops the connection
  client.connect({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    authHandler: (_methods, _partial, next) => {
      offered.attempts += 1;

      next({ type: 'password', username: imp.name, password: 'wrong' });
    },
  });

  await closed.promise;

  // the client sends its next attempt as the second refusal arrives
  expect(offered.attempts).toBeOneOf([2, 3]);
});

// a TCP proxy between the client and the gateway that can stop passing the
// client's packets on, as when the client's machine vanishes without a FIN
test('it drops a logged-in client that stops answering keepalives', async () => {
  const ctx = await setupTest({
    fileKeys: true,
    limits: { keepaliveIntervalMs: 20, keepaliveCountMax: 2 },
  });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();
  const link = { isSilent: false };

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const proxy = createServer((inbound) => {
    const outbound = createConnection({ host: '127.0.0.1', port: ctx.gateway.port });

    inbound.on('data', (data: Buffer) => {
      if (!link.isSilent) {
        outbound.write(data);
      }
    });

    outbound.pipe(inbound);

    inbound.on('end', () => {
      outbound.end();
    });

    inbound.on('error', () => {
      outbound.destroy();
    });

    outbound.on('error', () => {
      inbound.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    proxy.listen(0, '127.0.0.1', resolve);
  });

  onTestFinished(() => {
    proxy.close();
  });

  const address = proxy.address();

  if (typeof address !== 'object' || address === null) {
    throw new TypeError('the proxy has no TCP address');
  }

  const client = await openSshClient({
    host: '127.0.0.1',
    port: address.port,
    username: imp.name,
    privateKey: key.private,
  });

  const closed = Promise.withResolvers<void>();

  client.on('error', () => {});
  client.once('close', closed.resolve);

  link.isSilent = true;

  await closed.promise;

  await waitFor(() => {
    expect(ctx.ssh.tracker.count(imp.id, 'ssh')).toBe(0);
  });
});

test('it wakes the imp once for a login that opens no channel', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  // the client's end reaches the gateway after any wake the login started
  client.end();

  await waitFor(() => {
    expect(ctx.ssh.tracker.count(imp.id, 'ssh')).toBe(0);
  });

  expect(ctx.ssh.stub.wakes).toBe(1);
});

test('it answers a channel with the failed wake’s error and exit status 255', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord({ name: 'box' });
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.wakeError = new ORPCError('RAM_BUDGET_EXCEEDED', {
    message: 'no room for box under the RAM budget',
  });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('true', done);
  });

  const result = await opened.result;

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: RAM_BUDGET_EXCEEDED: no room for box under the RAM budget\n',
    code: 255,
    signal: null,
  });
});

test('it runs no program when the wake fails', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.wakeError = new ORPCError('RAM_BUDGET_EXCEEDED', { message: 'no room' });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('true', done);
  });

  await opened.result;

  expect(ctx.ssh.execs).toStrictEqual([]);
});

test('it answers a channel to a moving imp with MOVING and exit status 255', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord({ name: 'box' });
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.wakeError = buildMovingError(imp.name);

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('true', done);
  });

  const result = await opened.result;

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: MOVING: box is moving between hosts; try again in 30 s\n',
    code: 255,
    signal: null,
  });
});

test('it gives a shell a pty with the size and TERM of the request', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  await openSshChannel((done) => {
    client.shell({ cols: 120, rows: 40, term: 'xterm-kitty' }, done);
  });

  const run = await waitFor(() => {
    const [first] = ctx.ssh.execs;

    invariant(first);

    return first;
  });

  expect(run.request).toMatchObject({
    argv: ['/bin/sh', '-c', expect.any(String)],
    tty: true,
    cols: 120,
    rows: 40,
  });

  expect(run.request.env).toContain('TERM=xterm-kitty');
});

test('it passes a shell’s window change to the program', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.shell({ cols: 120, rows: 40, term: 'xterm' }, done);
  });

  await waitFor(() => {
    expect(ctx.ssh.execs).toHaveLength(1);
  });

  opened.channel.setWindow(50, 132, 0, 0);

  await waitFor(() => {
    expect(ctx.ssh.execs[0]?.resizes).toStrictEqual(['132x50']);
  });
});

test('it passes a shell’s signal to the program and its signal exit back', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.shell({ cols: 120, rows: 40, term: 'xterm' }, done);
  });

  const run = await waitFor(() => {
    const [first] = ctx.ssh.execs;

    invariant(first);

    return first;
  });

  opened.channel.signal('INT');

  await waitFor(() => {
    expect(run.signals).toStrictEqual([2]);
  });

  run.emit({ type: 'exit', code: 130, signal: 2 });

  // the wire says INT; ssh2's client adds the SIG
  const result = await opened.result;

  expect(result.signal).toBe('SIGINT');
});

// OpenSSH sends 0x0 when its own stdin is not a terminal (`ssh -tt` in a
// script); the agent then picks its default size
test('it leaves the size of a pty with no size to the agent', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  await openSshChannel((done) => {
    client.exec('tty', { pty: { cols: 0, rows: 0, term: 'xterm' } }, done);
  });

  const run = await waitFor(() => {
    const [first] = ctx.ssh.execs;

    invariant(first);

    return first;
  });

  expect(run.request.tty).toBeTrue();
  expect(run.request.cols).toBeUndefined();
  expect(run.request.rows).toBeUndefined();
});

// ssh2's client fails the exec on a refused env request, so a refused name
// is in the e2e suite, where OpenSSH ignores the refusal as it should
test('it passes LANG and LC_* to the program’s env', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('env', { env: { LANG: 'C.UTF-8', LC_ALL: 'C' } }, done);
  });

  await opened.result;

  expect(ctx.ssh.execs[0]?.request.env).toIncludeAllMembers(['LANG=C.UTF-8', 'LC_ALL=C']);
});

test('it runs sftp as the agent on the system drive', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  await openSshChannel((done) => {
    client.subsys('sftp', done);
  });

  const run = await waitFor(() => {
    const [first] = ctx.ssh.execs;

    invariant(first);

    return first;
  });

  expect(run.request).toMatchObject({ argv: ['/run/imp/sys/imp-agent', 'sftp'], tty: false });
  expect(run.feature).toBe('ssh');
});

test('it tells an sftp client of an outdated agent to restart the imp', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.execError = buildAgentOutdatedError('ssh');

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.subsys('sftp', done);
  });

  const result = await opened.result;

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      "imp: AGENT_OUTDATED: the imp's agent has no port forwarding or SFTP yet; stop and start the imp to update it\n",
    code: 255,
    signal: null,
  });
});

test('it carries several channels on one connection at once', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await Promise.all(
    ['one', 'two', 'three'].map((command) =>
      openSshChannel((done) => {
        client.exec(command, done);
      }),
    ),
  );

  await waitFor(() => {
    expect(ctx.ssh.execs).toHaveLength(3);
  });

  // each program prints its own command, once all three run
  for (const run of ctx.ssh.execs) {
    run.emit({ type: 'stdout', data: new TextEncoder().encode(run.request.argv[2] ?? '') });
    run.emit({ type: 'exit', code: 0, signal: 0 });
  }

  const results = await Promise.all(opened.map((each) => each.result));

  expect(results.map((result) => result.stdout)).toIncludeSameMembers(['one', 'two', 'three']);
});

test.each([
  ['localhost', '127.0.0.1:8080'],
  ['127.0.0.1', '127.0.0.1:8080'],
  ['::1', '[::1]:8080'],
])('it dials a forward to %s at %s in the guest', async (host, address) => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.forwardOut('127.0.0.1', 50_000, host, 8080, done);
  });

  opened.channel.end('request');

  await opened.result;

  expect(ctx.ssh.dials).toStrictEqual([
    { target: { network: 'tcp', address }, input: ['request'] },
  ]);
});

test('it relays a forward both ways, with a half-close from each side', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.forwardOut('127.0.0.1', 50_000, 'localhost', 8080, done);
  });

  // the stub dial answers only after the client's half-close
  opened.channel.end('request');

  const result = await opened.result;

  expect(result.stdout).toBe('got request');
});

test('it prohibits a forward to a host other than the guest’s loopback', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const forward = openSshChannel((done) => {
    client.forwardOut('127.0.0.1', 50_000, imp.ip, 22, done);
  });

  // RFC 4254 5.1: administratively prohibited
  expect(forward).rejects.toMatchObject({ reason: 1 });
  expect(ctx.ssh.dials).toStrictEqual([]);
});

test('it fails the open of a forward whose dial is refused as connect failed', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.dialError = new AgentError('DIAL_FAILED', 'connection refused');

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const forward = openSshChannel((done) => {
    client.forwardOut('127.0.0.1', 50_000, 'localhost', 9, done);
  });

  // RFC 4254 5.1: connect failed
  expect(forward).rejects.toMatchObject({ reason: 2 });
});

test('it dials a streamlocal forward at the unix socket in the guest', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.openssh_forwardOutStreamLocal('/run/app.sock', done);
  });

  opened.channel.end('ping');

  const result = await opened.result;

  expect(result.stdout).toBe('got ping');
  expect(ctx.ssh.dials[0]?.target).toStrictEqual({ network: 'unix', address: '/run/app.sock' });
});

test('it prohibits a streamlocal forward to impd’s sockets under /run/imp', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const forward = openSshChannel((done) => {
    client.openssh_forwardOutStreamLocal('/run/imp/ssh-agent/ab/agent.sock', done);
  });

  expect(forward).rejects.toMatchObject({ reason: 1 });
  expect(ctx.ssh.dials).toStrictEqual([]);
});

test('it ends every connection when it stops', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const closed = Promise.withResolvers<void>();

  client.once('close', closed.resolve);

  await ctx.gateway.stop();

  await closed.promise;

  await waitFor(() => {
    expect(ctx.ssh.tracker.count(imp.id)).toBe(0);
  });
});

test('it logs in a key added to authorized_keys on the next login, without a restart', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  const refused = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  expect(refused).rejects.toThrow();

  // an explicit new mtime, whatever the filesystem's clock granularity
  const later = new Date(Date.now() + 60_000);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });
  utimesSync(ctx.keysPath, later, later);

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const client = await login;

  expect(client).toBeInstanceOf(Client);
});

test('it refuses a key from an authorized_keys file that others can write', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });
  chmodSync(ctx.keysPath, 0o666);

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');

  expect(ctx.logs).toContain(
    `impd: ssh: ${ctx.keysPath} is writable by group or others; no key can log in until it is not`,
  );
});

test('it gives a command a guest socket for ssh -A that reaches the client’s agent', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const opened = await openSshChannel((done) => {
    client.exec('ssh-add -l', done);
  });

  await opened.result;

  expect(ctx.ssh.execs[0]?.request.env).toContain(
    'SSH_AUTH_SOCK=/run/imp/ssh-agent/stub1/agent.sock',
  );
});

test('it relays a guest client of the agent socket to the client’s agent and back', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const opened = await openSshChannel((done) => {
    client.exec('ssh-add -l', done);
  });

  await opened.result;

  ctx.ssh.listeners[0]?.connect(1);

  const accept = await waitFor(() => {
    const [first] = ctx.ssh.accepts;

    invariant(first);

    return first;
  });

  accept.send('list');

  await waitFor(() => {
    expect(accept.input.join('')).toBe('agent:list');
  });

  expect(accept).toMatchObject({ listener: 'stub1', id: 1 });
});

test('it closes the guest agent socket when the client leaves', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const opened = await openSshChannel((done) => {
    client.exec('ssh-add -l', done);
  });

  await opened.result;

  client.end();

  await waitFor(() => {
    expect(ctx.ssh.listeners[0]?.state.closed).toBeTrue();
  });
});

test('it gives a connection without -A no agent socket', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('true', done);
  });

  await opened.result;

  const env = ctx.ssh.execs[0]?.request.env;

  invariant(env);

  expect(env.join('\n')).not.toInclude('SSH_AUTH_SOCK=');
});

test('it gives sftp no agent socket, even with -A', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  await openSshChannel((done) => {
    client.subsys('sftp', done);
  });

  const run = await waitFor(() => {
    const [first] = ctx.ssh.execs;

    invariant(first);

    return first;
  });

  invariant(run.request.env);

  expect(run.request.env.join('\n')).not.toInclude('SSH_AUTH_SOCK=');
  expect(ctx.ssh.listeners).toStrictEqual([]);
});

test('it shares one guest agent socket between sessions that start together', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const opened = await Promise.all(
    ['one', 'two', 'three'].map((command) =>
      openSshChannel((done) => {
        client.exec(command, done);
      }),
    ),
  );

  await Promise.all(opened.map((each) => each.result));

  expect(ctx.ssh.listeners).toHaveLength(1);

  expect(ctx.ssh.execs).toSatisfyAll(
    (run: (typeof ctx.ssh.execs)[number]) =>
      run.request.env?.includes('SSH_AUTH_SOCK=/run/imp/ssh-agent/stub1/agent.sock') === true,
  );
});

test('it makes the guest agent socket again after it ended, as after a forced sleep', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const first = await openSshChannel((done) => {
    client.exec('one', done);
  });

  await first.result;

  ctx.ssh.listeners[0]?.end();

  await waitFor(() => {
    expect(ctx.ssh.listeners[0]?.state.closed).toBeTrue();
  });

  const second = await openSshChannel((done) => {
    client.exec('two', done);
  });

  await second.result;

  expect(ctx.ssh.execs[1]?.request.env).toContain(
    'SSH_AUTH_SOCK=/run/imp/ssh-agent/stub2/agent.sock',
  );
});

test('it gives a session in a new VM, after a wake, a new agent socket at once', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const first = await openSshChannel((done) => {
    client.exec('one', done);
  });

  await first.result;

  // a new VM; the old listener has not ended yet, as when impd learns of it late
  ctx.ssh.putImp({ ...imp, pid: (imp.pid ?? 0) + 1 });

  const second = await openSshChannel((done) => {
    client.exec('two', done);
  });

  await second.result;

  expect(ctx.ssh.listeners.map((listener) => listener.state.closed)).toStrictEqual([true, false]);

  expect(ctx.ssh.execs[1]?.request.env).toContain(
    'SSH_AUTH_SOCK=/run/imp/ssh-agent/stub2/agent.sock',
  );
});

// ssh2 refuses the agent channel when it cannot reach its agent
test('it closes a guest agent client at once when the client refuses the agent channel', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const dir = await mkdtemp(join(tmpdir(), 'imp-no-agent-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: join(dir, 'agent.sock'),
    agentForward: true,
  });

  const opened = await openSshChannel((done) => {
    client.exec('ssh-add -l', done);
  });

  await opened.result;

  ctx.ssh.listeners[0]?.connect(1);

  await waitFor(() => {
    expect(ctx.ssh.accepts[0]?.state.closed).toBeTrue();
  });

  expect(ctx.ssh.accepts[0]?.input).toStrictEqual([]);
  expect(ctx.logs.join('\n')).toInclude('the client refused the agent channel');
});

test('it closes the guest agent clients past the cap of agent channels', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'hold' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const opened = await openSshChannel((done) => {
    client.exec('flood', done);
  });

  await opened.result;

  const [listener] = ctx.ssh.listeners;

  invariant(listener);

  // fills the cap with held channels, then one more
  for (let id = 1; id <= MAX_AGENT_CHANNELS; id += 1) {
    listener.connect(id);
  }

  await waitFor(() => {
    expect(ctx.ssh.accepts).toHaveLength(MAX_AGENT_CHANNELS);
  });

  listener.connect(MAX_AGENT_CHANNELS + 1);

  await waitFor(() => {
    expect(ctx.ssh.accepts).toHaveLength(MAX_AGENT_CHANNELS + 1);
  });

  const closed = ctx.ssh.accepts.filter((each) => each.state.closed).map((each) => each.id);

  expect(closed).toStrictEqual([MAX_AGENT_CHANNELS + 1]);
});

test('it runs a command without the agent socket when the agent is outdated', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.listenError = buildAgentOutdatedError('agent-forwarding');

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const opened = await openSshChannel((done) => {
    client.exec('git push', done);
  });

  const result = await opened.result;

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      "imp: no agent forwarding: AGENT_OUTDATED: the imp's agent has no ssh-agent forwarding yet; stop and start the imp to update it\n",
    code: 0,
    signal: null,
  });
});

test('it gives a command no agent socket when the agent is outdated', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.listenError = buildAgentOutdatedError('agent-forwarding');

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const opened = await openSshChannel((done) => {
    client.exec('git push', done);
  });

  await opened.result;

  const env = ctx.ssh.execs[0]?.request.env;

  invariant(env);

  expect(env.join('\n')).not.toInclude('SSH_AUTH_SOCK=');
});

test('it tries the agent socket again for the next session after any failure', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  const agent = await startStubSshAgent({ mode: 'answer' });

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  ctx.ssh.stub.listenError = buildAgentOutdatedError('agent-forwarding');

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
    agent: agent.path,
    agentForward: true,
  });

  const first = await openSshChannel((done) => {
    client.exec('git push', done);
  });

  await first.result;

  ctx.ssh.stub.listenError = new AgentError('INTERNAL', 'unknown user "dev"');

  const second = await openSshChannel((done) => {
    client.exec('git push', done);
  });

  const result = await second.result;

  expect(result.stderr).toBe('imp: no agent forwarding: INTERNAL: unknown user "dev"\n');
});

// keys bound to tokens (docs/guides/ssh.md#keys-bound-to-tokens)

test('it logs a key bound to a token in to its imps, as the token', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord({ name: 'box' });
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  await ctx.tokens.create({ name: 'boxes', scope: 'exec', imps: ['bo*'], sshKeys: [key.public] });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('true', done);
  });

  await opened.result;

  expect(ctx.ssh.actors).toStrictEqual([{ kind: 'ssh', name: 'boxes' }]);
});

test('it refuses a key bound to dev-* on another imp before any imp lookup', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord({ name: 'box' });
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'], sshKeys: [key.public] });

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
  expect(ctx.ssh.stub.lookups).toBe(0);
  expect(ctx.ssh.stub.wakes).toBe(0);
});

test('it refuses a key on a read-only token as it refuses an unknown key', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'viewer', scope: 'read', imps: null, sshKeys: [key.public] });

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
  expect(ctx.ssh.stub.wakes).toBe(0);
  expect(ctx.ssh.tracker.count(imp.id)).toBe(0);
});

test('it refuses to bind a key that authorized_keys lists', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const key = createEd25519Key();

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: null });

  expect(ctx.tokens.addKey('ci', key.public)).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('it refuses to bind a key that authorized_keys lists while the file grants nothing', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const key = createEd25519Key();

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });
  chmodSync(ctx.keysPath, 0o666);

  await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: null });

  expect(ctx.tokens.addKey('ci', key.public)).rejects.toMatchObject({ code: 'CONFLICT' });
});

// A binding next to a file line would hand the key every imp once removed:
// the key must not fall back to the file's access.
test('it refuses to unbind a key that authorized_keys lists too', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const key = createEd25519Key();

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'], sshKeys: [key.public] });

  const fingerprint = ctx.tokens.list()[0]?.sshKeys[0]?.fingerprint ?? '';

  const later = new Date(Date.now() + 60_000);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });
  utimesSync(ctx.keysPath, later, later);

  expect(ctx.tokens.removeKey('dev', fingerprint)).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('it refuses to remove a token whose bound key authorized_keys lists too', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const key = createEd25519Key();

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'], sshKeys: [key.public] });

  const later = new Date(Date.now() + 60_000);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });
  utimesSync(ctx.keysPath, later, later);

  expect(ctx.tokens.remove('dev')).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('it logs a bound key that authorized_keys lists later in only as its token', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord({ name: 'box' });
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'], sshKeys: [key.public] });

  const later = new Date(Date.now() + 60_000);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });
  utimesSync(ctx.keysPath, later, later);

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});

test('it refuses a key once its binding is removed after its file line was', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord({ name: 'box' });
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  await ctx.tokens.create({ name: 'dev', scope: 'exec', imps: ['dev-*'] });

  // the file held the key once; the binding comes after its line goes
  const removed = new Date(Date.now() + 60_000);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });
  utimesSync(ctx.keysPath, removed, removed);

  const added = await ctx.tokens.addKey('dev', key.public);

  await ctx.tokens.removeKey('dev', added.fingerprint);

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});

test('it refuses a key whose binding was removed', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: null });

  const added = await ctx.tokens.addKey('ci', key.public);

  await ctx.tokens.removeKey('ci', added.fingerprint);

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});

test('it refuses a key from authorized_keys when the file is off', async () => {
  const ctx = await setupTest({ fileKeys: false, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});

test('it logs a bound key in while authorized_keys is off', async () => {
  const ctx = await setupTest({ fileKeys: false, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: null, sshKeys: [key.public] });

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const client = await login;

  expect(client).toBeInstanceOf(Client);
});

test('it audits a key from authorized_keys as key and its comment', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public} me@laptop\n`, { mode: 0o600 });

  ctx.ssh.stub.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const opened = await openSshChannel((done) => {
    client.exec('true', done);
  });

  await opened.result;

  expect(ctx.ssh.actors).toStrictEqual([{ kind: 'ssh', name: 'key me@laptop' }]);
});

test('it ends a live ssh connection when its token is removed', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: null, sshKeys: [key.public] });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const closed = Promise.withResolvers<void>();

  client.once('close', closed.resolve);

  await ctx.tokens.remove('ci');

  expect(closed.promise).resolves.toBeUndefined();
});

test('it ends a live ssh connection when its bound key is removed', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: null });

  const added = await ctx.tokens.addKey('ci', key.public);

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const closed = Promise.withResolvers<void>();

  client.once('close', closed.resolve);

  await ctx.tokens.removeKey('ci', added.fingerprint);

  expect(closed.promise).resolves.toBeUndefined();
});

// the removal lands after the key was found, before the connection watches
// for it
test('it ends at once a login whose key was removed as it logged in', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, '', { mode: 0o600 });

  await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: null, sshKeys: [key.public] });

  const parsed = utils.parseKey(key.public);

  if (parsed instanceof Error) {
    throw parsed;
  }

  const keyId = ctx.tokens.findSshKey(parsed.getPublicSSH())?.keyId;

  invariant(keyId);

  ctx.revocations.revoke(keyId);

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const closed = Promise.withResolvers<void>();

  client.once('close', closed.resolve);

  expect(closed.promise).resolves.toBeUndefined();
});

test('it listens for ssh -R 0 on the guest loopback at the port the agent picks', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const bound = await new Promise<number>((resolve, reject) => {
    client.forwardIn('', 0, (failure, port) => {
      if (failure === undefined) {
        resolve(port);
      } else {
        reject(failure);
      }
    });
  });

  expect(ctx.ssh.listeners[0]?.spec).toStrictEqual({ network: 'tcp', port: 0 });

  // the stub agent picks 40000 plus its listener count
  expect(bound).toBe(40_001);
});

test('it relays each guest client of ssh -R back to the client', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const reached: string[] = [];

  client.on('tcp connection', (info, accept) => {
    const channel = accept();

    reached.push(`${info.destIP}:${String(info.destPort)}`);

    channel.on('data', (data: Buffer) => {
      channel.write(`back:${data.toString()}`);
    });
  });

  await new Promise<number>((resolve, reject) => {
    client.forwardIn('', 0, (failure, port) => {
      if (failure === undefined) {
        resolve(port);
      } else {
        reject(failure);
      }
    });
  });

  ctx.ssh.listeners[0]?.connect(1);

  const accept = await waitFor(() => {
    const [first] = ctx.ssh.accepts;

    invariant(first);

    return first;
  });

  accept.send('hello');

  await waitFor(() => {
    expect(accept.input.join('')).toBe('back:hello');
  });

  // the client matches the channel to its forward by the address it asked
  expect(reached).toStrictEqual([':40001']);
});

test('it closes the guest listener of ssh -R when the client leaves', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  await new Promise<number>((resolve, reject) => {
    client.forwardIn('', 0, (failure, port) => {
      if (failure === undefined) {
        resolve(port);
      } else {
        reject(failure);
      }
    });
  });

  client.end();

  await waitFor(() => {
    expect(ctx.ssh.listeners[0]?.state.closed).toBeTrue();
  });
});

test('it listens for ssh -R to a unix socket at that path, and relays its clients', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const reached: string[] = [];

  client.on('unix connection', (info, accept) => {
    const channel = accept();

    reached.push(info.socketPath);

    channel.on('data', (data: Buffer) => {
      channel.write(`back:${data.toString()}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    client.openssh_forwardInStreamLocal('/home/dev/.atc/atc.sock', (failure) => {
      if (failure instanceof Error) {
        reject(failure);
      } else {
        resolve();
      }
    });
  });

  ctx.ssh.listeners[0]?.connect(1);

  const accept = await waitFor(() => {
    const [first] = ctx.ssh.accepts;

    invariant(first);

    return first;
  });

  accept.send('report');

  await waitFor(() => {
    expect(accept.input.join('')).toBe('back:report');
  });

  expect(ctx.ssh.listeners[0]?.spec).toStrictEqual({
    network: 'unix',
    path: '/home/dev/.atc/atc.sock',
  });

  expect(reached).toStrictEqual(['/home/dev/.atc/atc.sock']);
});

test('it refuses ssh -R on a bind address other than the loopback', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const forward = new Promise<number>((resolve, reject) => {
    client.forwardIn('10.0.0.5', 8000, (failure, port) => {
      if (failure === undefined) {
        resolve(port);
      } else {
        reject(failure);
      }
    });
  });

  expect(forward).rejects.toThrowWithMessage(Error, 'Unable to bind to 10.0.0.5:8000');
  expect(ctx.ssh.listeners).toStrictEqual([]);
});

test.each([
  ['the agent sockets', '/run/imp/ssh-agent/x/agent.sock'],
  ['a relative path', 'app.sock'],
])('it refuses ssh -R to a unix socket at %s', async (_label, socketPath) => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const forward = new Promise<void>((resolve, reject) => {
    client.openssh_forwardInStreamLocal(socketPath, (failure) => {
      if (failure instanceof Error) {
        reject(failure);
      } else {
        resolve();
      }
    });
  });

  expect(forward).rejects.toThrow();
  expect(ctx.ssh.listeners).toStrictEqual([]);
});

test.each(['0.0.0.0', '*', 'localhost', '::'])(
  'it binds ssh -R on %s to the guest loopback',
  async (bindAddr) => {
    const ctx = await setupTest({ fileKeys: true, limits: {} });

    const imp = buildMockImpRecord();
    const key = createEd25519Key();

    ctx.ssh.putImp(imp);

    writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

    const client = await openSshClient({
      host: '127.0.0.1',
      port: ctx.gateway.port,
      username: imp.name,
      privateKey: key.private,
    });

    await new Promise<number>((resolve, reject) => {
      client.forwardIn(bindAddr, 9000, (failure, port) => {
        if (failure === undefined) {
          resolve(port);
        } else {
          reject(failure);
        }
      });
    });

    expect(ctx.ssh.listeners.map((listener) => listener.spec)).toStrictEqual([
      { network: 'tcp', port: 9000 },
    ]);
  },
);

test('it listens once for two requests for the same remote forward at once', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  const settled = await Promise.allSettled(
    [1, 2].map(
      () =>
        new Promise<number>((resolve, reject) => {
          client.forwardIn('localhost', 9000, (failure, port) => {
            if (failure === undefined) {
              resolve(port);
            } else {
              reject(failure);
            }
          });
        }),
    ),
  );

  expect(settled.map((result) => result.status)).toIncludeSameMembers(['fulfilled', 'rejected']);
  expect(ctx.ssh.listeners).toHaveLength(1);
});

test('it closes the guest listener of a cancelled remote forward', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  await new Promise<number>((resolve, reject) => {
    client.forwardIn('localhost', 9000, (failure, port) => {
      if (failure === undefined) {
        resolve(port);
      } else {
        reject(failure);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    client.unforwardIn('localhost', 9000, (failure) => {
      if (failure instanceof Error) {
        reject(failure);
      } else {
        resolve();
      }
    });
  });

  await waitFor(() => {
    expect(ctx.ssh.listeners[0]?.state.closed).toBeTrue();
  });
});

test('it closes a guest client of ssh -R at once when the ssh client refuses it', async () => {
  const ctx = await setupTest({ fileKeys: true, limits: {} });

  const imp = buildMockImpRecord();
  const key = createEd25519Key();

  ctx.ssh.putImp(imp);

  writeFileSync(ctx.keysPath, `${key.public}\n`, { mode: 0o600 });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.gateway.port,
    username: imp.name,
    privateKey: key.private,
  });

  client.on('tcp connection', (_info, _accept, reject) => {
    reject();
  });

  await new Promise<number>((resolve, reject) => {
    client.forwardIn('', 9000, (failure, port) => {
      if (failure === undefined) {
        resolve(port);
      } else {
        reject(failure);
      }
    });
  });

  ctx.ssh.listeners[0]?.connect(1);

  await waitFor(() => {
    expect(ctx.ssh.accepts[0]?.state.closed).toBeTrue();
  });
});
