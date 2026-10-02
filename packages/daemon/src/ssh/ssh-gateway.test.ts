import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORPCError } from '@orpc/server';
import { Client } from 'ssh2';
import type { ClientChannel, ExecOptions } from 'ssh2';
import { AgentError } from '../agent-client/agent-connection';
import { buildAgentOutdatedError } from '../agent-client/agent-outdated';
import { readRejection } from '../read-rejection';
import { createAuthorizedKeys } from './authorized-keys';
import { FAKE_IMP, createFakeSshBackend } from './fake-ssh-backend';
import { createEd25519Key } from './host-key';
import { startSshGateway } from './ssh-gateway';
import type { SshGateway } from './ssh-gateway';

const HOST_KEY = createEd25519Key().private;
const USER_KEY = createEd25519Key();
const OTHER_KEY = createEd25519Key();
const REFUSED = 'All configured authentication methods failed';

// RFC 4254 5.1 reason codes, as ssh2 sets them on a failed open
const OPEN_FAILURE = { administrativelyProhibited: 1, connectFailed: 2 } as const;

const encoder = new TextEncoder();

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function startTestGateway(keysText = `${USER_KEY.public}\n`) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-ssh-'));
  const keysPath = join(dir, 'authorized_keys');
  const logs: string[] = [];

  const writeLog = (message: string): void => {
    logs.push(message);
  };

  chmodSync(dir, 0o700);
  writeFileSync(keysPath, keysText, { mode: 0o600 });

  const parts = createFakeSshBackend();

  const gateway = await startSshGateway(
    {
      hostKey: HOST_KEY,
      authorizedKeys: createAuthorizedKeys(keysPath, writeLog),
      backend: parts.backend,
      log: writeLog,
    },
    0,
    '127.0.0.1',
  );

  cleanups.push(async () => {
    await gateway.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  return { ...parts, gateway, logs, keysPath };
}

function openClient(
  gateway: SshGateway,
  username = FAKE_IMP.name,
  privateKey = USER_KEY.private,
): Promise<Client> {
  const client = new Client();

  cleanups.push(() => {
    client.end();
  });

  return new Promise((resolve, reject) => {
    client.once('ready', () => {
      resolve(client);
    });

    // `on`: a refused client can emit a second error after the first
    client.on('error', reject);

    client.connect({
      host: '127.0.0.1',
      port: gateway.port,
      username,
      privateKey,

      // ssh2 offers streamlocal only to a server named OpenSSH
      strictVendor: false,
    });
  });
}

interface ChannelResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: string | null;
}

const results = new WeakMap<ClientChannel, Promise<ChannelResult>>();

function startCollecting(channel: ClientChannel): Promise<ChannelResult> {
  const out: { stdout: string; stderr: string; code: number | null; signal: string | null } = {
    stdout: '',
    stderr: '',
    code: null,
    signal: null,
  };

  channel.on('data', (data: Buffer) => {
    out.stdout += data.toString();
  });

  channel.stderr.on('data', (data: Buffer) => {
    out.stderr += data.toString();
  });

  channel.on('exit', (code: number | null, signal?: string) => {
    out.code = code;
    out.signal = signal ?? null;
  });

  return new Promise((resolve) => {
    channel.on('close', () => {
      resolve(out);
    });
  });
}

// everything a channel printed, and how it exited
function readResult(channel: ClientChannel): Promise<ChannelResult> {
  const result = results.get(channel);

  if (result === undefined) {
    throw new Error('the channel was not opened with openChannel');
  }

  return result;
}

type OpenCallback = (failure: Readonly<Error> | undefined, channel: ClientChannel) => void;

// Opens a channel through one of ssh2's callback methods. Its output is
// collected from the start: ssh2 emits `exit` once, and it can come in the
// same packet as the open's answer, before a test could listen.
function openChannel(open: (done: OpenCallback) => void): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    open((failure, channel) => {
      if (failure !== undefined) {
        reject(failure);

        return;
      }

      results.set(channel, startCollecting(channel));

      resolve(channel);
    });
  });
}

function openExecChannel(
  client: Client,
  command: string,
  env: Readonly<Record<string, string>> = {},
): Promise<ClientChannel> {
  const options: ExecOptions = { env: { ...env } };

  return openChannel((done) => {
    client.exec(command, options, done);
  });
}

function openForward(client: Client, host: string, port: number): Promise<ClientChannel> {
  return openChannel((done) => {
    client.forwardOut('127.0.0.1', 50_000, host, port, done);
  });
}

// a login the gateway refused
async function assertRefused(login: Promise<Client>): Promise<void> {
  const failure = await readRejection(login);

  expect(failure).toMatchObject({ message: REFUSED });
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await Bun.sleep(5);
  }
}

test('an exec runs the command with sh and returns its output and exit status', async () => {
  const ctx = await startTestGateway();

  ctx.fake.onExec = (run) => {
    run.emit({ type: 'stdout', data: encoder.encode('hi\n') });
    run.emit({ type: 'stderr', data: encoder.encode('err\n') });
    run.emit({ type: 'exit', code: 3, signal: 0 });
  };

  const client = await openClient(ctx.gateway);

  expect(ctx.tracker.count(FAKE_IMP.id, 'ssh')).toBe(1);

  const channel = await openExecChannel(client, 'echo hi; echo err >&2; exit 3');
  const result = await readResult(channel);

  expect(result).toEqual({ stdout: 'hi\n', stderr: 'err\n', code: 3, signal: null });

  const request = ctx.execs[0]?.request;
  const sshConnection = request?.env?.find((entry) => entry.startsWith('SSH_CONNECTION='));

  expect(request?.argv).toEqual(['/bin/sh', '-c', 'echo hi; echo err >&2; exit 3']);
  expect(request?.tty).toBe(false);
  expect(sshConnection).toMatch(/^SSH_CONNECTION=127\.0\.0\.1 \d+ 127\.0\.0\.1 \d+$/);
  expect(sshConnection?.endsWith(` ${String(ctx.gateway.port)}`)).toBe(true);

  client.end();

  await waitUntil(() => ctx.tracker.count(FAKE_IMP.id, 'ssh') === 0);
});

test('stdin reaches the program, and the client EOF closes it', async () => {
  const ctx = await startTestGateway();
  const client = await openClient(ctx.gateway);
  const channel = await openExecChannel(client, 'cat');

  channel.end('some input');

  await waitUntil(() => ctx.execs[0]?.stdin.at(-1) === '<eof>');

  expect(ctx.execs[0]?.stdin.join('')).toBe('some input<eof>');
});

test('an unknown user and an unknown key get the same refusal, and neither wakes the imp', async () => {
  const ctx = await startTestGateway();

  await assertRefused(openClient(ctx.gateway, 'nobody'));
  await assertRefused(openClient(ctx.gateway, FAKE_IMP.name, OTHER_KEY.private));

  expect(ctx.fake.wakes).toBe(0);
  expect(ctx.tracker.count(FAKE_IMP.id)).toBe(0);
});

test('a login wakes the imp once, before any channel', async () => {
  const ctx = await startTestGateway();

  await openClient(ctx.gateway);
  await waitUntil(() => ctx.fake.wakes === 1);
});

test('a failed wake reaches the channel as an error with exit status 255', async () => {
  const ctx = await startTestGateway();

  ctx.fake.wakeError = new ORPCError('RAM_BUDGET_EXCEEDED', {
    message: 'no room for box under the RAM budget',
  });

  const client = await openClient(ctx.gateway);
  const channel = await openExecChannel(client, 'true');
  const result = await readResult(channel);

  expect(result.code).toBe(255);
  expect(result.stderr).toBe('imp: RAM_BUDGET_EXCEEDED: no room for box under the RAM budget\n');
  expect(ctx.execs).toHaveLength(0);
});

test('a shell gets a pty with the size and TERM of the request, resizes and signals', async () => {
  const ctx = await startTestGateway();
  const client = await openClient(ctx.gateway);

  const window = { cols: 120, rows: 40, term: 'xterm-kitty' };

  const channel = await openChannel((done) => {
    client.shell(window, done);
  });

  await waitUntil(() => ctx.execs.length === 1);

  const [run] = ctx.execs;

  expect(run?.request.tty).toBe(true);
  expect(run?.request.argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
  expect(run?.request).toMatchObject({ cols: 120, rows: 40 });
  expect(run?.request.env).toContain('TERM=xterm-kitty');

  channel.setWindow(50, 132, 0, 0);
  channel.signal('INT');

  await waitUntil(() => run?.resizes.includes('132x50') === true && run.signals.length === 1);

  expect(run?.signals).toEqual([2]);
  run?.emit({ type: 'exit', code: 130, signal: 2 });

  const result = await readResult(channel);

  // the wire says INT; ssh2's client adds the SIG
  expect(result.signal).toBe('SIGINT');
});

// OpenSSH sends 0x0 when its own stdin is not a terminal (`ssh -tt` in a
// script); the agent then picks its default size
test('a pty with no size leaves the size to the agent', async () => {
  const ctx = await startTestGateway();
  const client = await openClient(ctx.gateway);

  await openChannel((done) => {
    client.exec('tty', { pty: { cols: 0, rows: 0, term: 'xterm' } }, done);
  });

  await waitUntil(() => ctx.execs.length === 1);

  expect(ctx.execs[0]?.request.tty).toBe(true);
  expect(ctx.execs[0]?.request.cols).toBeUndefined();
  expect(ctx.execs[0]?.request.rows).toBeUndefined();
});

// ssh2's client fails the exec on a refused env request, so a refused name
// is in the e2e suite, where OpenSSH ignores the refusal as it should
test('LANG and LC_* reach the env', async () => {
  const ctx = await startTestGateway();

  ctx.fake.onExec = (run) => {
    run.emit({ type: 'exit', code: 0, signal: 0 });
  };

  const client = await openClient(ctx.gateway);
  const channel = await openExecChannel(client, 'env', { LANG: 'C.UTF-8', LC_ALL: 'C' });

  await readResult(channel);

  const env = ctx.execs[0]?.request.env ?? [];

  expect(env).toContain('LANG=C.UTF-8');
  expect(env).toContain('LC_ALL=C');
});

test('sftp runs the agent on the system drive, and an old agent gets told to restart the imp', async () => {
  const ctx = await startTestGateway();
  const client = await openClient(ctx.gateway);

  const first = await openChannel((done) => {
    client.subsys('sftp', done);
  });

  await waitUntil(() => ctx.execs.length === 1);

  expect(ctx.execs[0]?.request).toMatchObject({
    argv: ['/run/imp/sys/imp-agent', 'sftp'],
    tty: false,
  });

  expect(ctx.execs[0]?.feature).toBe('ssh');
  ctx.execs[0]?.emit({ type: 'exit', code: 0, signal: 0 });

  await readResult(first);

  ctx.fake.execError = buildAgentOutdatedError('ssh');

  const second = await openChannel((done) => {
    client.subsys('sftp', done);
  });

  const result = await readResult(second);

  expect(result.code).toBe(255);

  expect(result.stderr).toBe(
    "imp: AGENT_OUTDATED: the imp's agent has no port forwarding or SFTP yet; stop and start the imp to update it\n",
  );
});

test('one connection carries several channels at once', async () => {
  const ctx = await startTestGateway();
  const client = await openClient(ctx.gateway);

  const channels = await Promise.all(
    ['one', 'two', 'three'].map((command) => openExecChannel(client, command)),
  );

  await waitUntil(() => ctx.execs.length === 3);

  for (const run of ctx.execs) {
    run.emit({ type: 'stdout', data: encoder.encode(run.request.argv[2] ?? '') });
    run.emit({ type: 'exit', code: 0, signal: 0 });
  }

  const finished = await Promise.all(channels.map((channel) => readResult(channel)));

  expect(finished.map((result) => result.stdout).toSorted()).toEqual(['one', 'three', 'two']);
});

test('a forward to the loopback dials it in the guest, with a half-close each way', async () => {
  const ctx = await startTestGateway();
  const client = await openClient(ctx.gateway);

  const cases = [
    ['localhost', '127.0.0.1:8080'],
    ['127.0.0.1', '127.0.0.1:8080'],
    ['::1', '[::1]:8080'],
  ] as const;

  for (const [host, address] of cases) {
    const channel = await openForward(client, host, 8080);

    channel.end('request');

    const result = await readResult(channel);

    expect(result.stdout).toBe('got request');
    expect(ctx.dials.at(-1)?.target).toEqual({ network: 'tcp', address });
  }
});

test('a forward to any other host is administratively prohibited', async () => {
  const ctx = await startTestGateway();
  const client = await openClient(ctx.gateway);

  for (const host of ['10.66.0.1', 'example.com', '0.0.0.0', FAKE_IMP.ip]) {
    const failure = await readRejection(openForward(client, host, 22));

    expect(failure).toMatchObject({
      reason: OPEN_FAILURE.administrativelyProhibited,
    });
  }

  expect(ctx.dials).toHaveLength(0);
});

test('a refused dial fails the channel open as connect failed', async () => {
  const ctx = await startTestGateway();

  ctx.fake.dialError = new AgentError('DIAL_FAILED', 'connection refused');

  const client = await openClient(ctx.gateway);
  const failure = await readRejection(openForward(client, 'localhost', 9));

  expect(failure).toMatchObject({
    reason: OPEN_FAILURE.connectFailed,
  });
});

test('a streamlocal forward dials the unix socket in the guest', async () => {
  const ctx = await startTestGateway();
  const client = await openClient(ctx.gateway);

  const channel = await openChannel((done) => {
    client.openssh_forwardOutStreamLocal('/run/app.sock', done);
  });

  channel.end('ping');

  const result = await readResult(channel);

  expect(result.stdout).toBe('got ping');
  expect(ctx.dials[0]?.target).toEqual({ network: 'unix', address: '/run/app.sock' });
});

test('stop ends every connection', async () => {
  const ctx = await startTestGateway();
  const client = await openClient(ctx.gateway);

  const ended = new Promise<void>((resolve) => {
    client.once('close', resolve);
  });

  await ctx.gateway.stop();

  await ended;
  await waitUntil(() => ctx.tracker.count(FAKE_IMP.id) === 0);
});

test('a key added to authorized_keys works on the next login, without a restart', async () => {
  const ctx = await startTestGateway('');

  await assertRefused(openClient(ctx.gateway));

  // a new mtime, even on a coarse clock
  await Bun.sleep(10);

  writeFileSync(ctx.keysPath, `${USER_KEY.public}\n`, { mode: 0o600 });

  await openClient(ctx.gateway);
});

test('a key file that others can write grants nothing', async () => {
  const ctx = await startTestGateway();

  chmodSync(ctx.keysPath, 0o666);

  await assertRefused(openClient(ctx.gateway));

  expect(ctx.logs.some((line) => line.includes('writable by group or others'))).toBe(true);
});
