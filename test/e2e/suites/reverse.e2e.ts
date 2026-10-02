import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { dirname } from 'node:path';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, readState, runImp, runShellInImp, startImp, tryImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { SSH_HOST, setupSshClient, startLocalSshAgent, startSsh } from '../lib/ssh';
import type { LocalSshAgent, SshClient } from '../lib/ssh';
import { waitFor } from '../lib/wait-for';

// Reverse forwards (docs/guides/reverse-forwards.md), by `imp proxy
// --reverse` and `ssh -R`. This machine's ssh-agent is the unix socket
// service, and `ssh-add -l` in the imp, as the image user, its client.

const prefix = setupSuite('reverse');
const name = `${prefix}a`;
const PAGE = 'e2e-reverse-ok\n';

const decoder = new TextDecoder();

let client: SshClient;
let laptop: LocalSshAgent;
let page: ReturnType<typeof Bun.serve>;

// a TCP server on this machine that greets each client and never closes
let holder: Server;
let holderPort: number;

beforeAll(async () => {
  client = await setupSshClient();
  laptop = await startLocalSshAgent(client);

  page = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE) });

  holder = createServer((socket) => {
    socket.write('held\n');
  });

  const listening = Promise.withResolvers<void>();

  holder.listen(0, '127.0.0.1', listening.resolve);

  await listening.promise;

  const address = holder.address();

  holderPort = typeof address === 'object' && address !== null ? address.port : 0;

  await createImp(name, '--image', resolveImageName('e2e-git'), '--memory', '256');
  await holdImp(name);
}, 120_000);

afterAll(async () => {
  holder.close();

  await page.stop(true);
  await laptop[Symbol.asyncDispose]();
  await client.cleanup();
});

interface OutputSink {
  text: string;
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- the sink collects
async function collectOutput(stream: ReadableStream<Uint8Array>, sink: OutputSink): Promise<void> {
  for await (const chunk of stream) {
    sink.text += decoder.decode(chunk);
  }
}

interface RunningReverse {
  // where each forward listens in the imp, in order
  readonly guests: readonly string[];
  readonly readStderr: () => string;
  readonly stop: () => Promise<number>;
}

// `imp proxy <name> --reverse <spec>...`, once it printed a line for each
async function startReverse(...specs: readonly string[]): Promise<RunningReverse> {
  const proc = await startImp(['proxy', name, ...specs.flatMap((spec) => ['--reverse', spec])]);

  const stderr = { text: '' };
  const stdout = { text: '' };

  void collectOutput(proc.stderr, stderr);
  void collectOutput(proc.stdout, stdout);

  const guests = await waitFor('imp proxy --reverse to listen', () => {
    const found = [...stdout.text.matchAll(/^forwarding [^:]+:(?<guest>\S+) ->/gmv)];

    if (found.length < specs.length) {
      throw new Error(`imp proxy printed ${stdout.text}${stderr.text}`);
    }

    return found.map((match) => match.groups?.['guest'] ?? '');
  });

  return {
    guests,
    readStderr: () => stderr.text,
    stop: () => {
      proc.kill('SIGINT');

      return proc.exited;
    },
  };
}

function listKeys(socket: string): Promise<string> {
  return runShellInImp(name, `SSH_AUTH_SOCK='${socket}' ssh-add -l 2>&1; echo "code=$?"`);
}

function checkExists(path: string): Promise<string> {
  return runShellInImp(name, `if [ -e '${path}' ]; then echo there; else echo gone; fi`);
}

async function waitGone(path: string): Promise<void> {
  await waitFor(`${path} to go`, async () => {
    const state = await checkExists(path);

    if (state !== 'gone') {
      throw new Error(`${path} is still there`);
    }
  });
}

test('a refused forward fails at once and says why', async () => {
  const missing = await tryImp(['proxy', name, '--reverse', '/nope/app.sock:9']);
  const low = await tryImp(['proxy', name, '--reverse', '80:9']);
  const ours = await tryImp(['proxy', name, '--reverse', '/run/imp/x.sock:9']);

  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain('the directory /nope does not exist in the imp');
  expect(low.exitCode).toBe(1);
  expect(low.stderr).toContain('port 80 needs root in the imp; pick a port above 1023');
  expect(ours.exitCode).toBe(1);
  expect(ours.stderr).toContain("leads to the agent's own sockets");
});

test('a process in the imp reaches a unix socket and a port on this machine', async () => {
  const socket = '/tmp/e2e-agent.sock';

  const reverse = await startReverse(
    `${socket}:${laptop.socket}`,
    `0:${String(page.port)}`,
    `:${laptop.socket}`,
  );

  try {
    const [path = '', port = '', own = ''] = reverse.guests;

    expect(path).toBe(socket);
    expect(own).toStartWith('/run/imp/forward/');

    const listed = await listKeys(path);
    const listedOwn = await listKeys(own);

    const modes = await runShellInImp(
      name,
      `stat -c "%U %a" '${path}' '${own}' "$(dirname '${own}')"`,
    );

    const fetched = await runShellInImp(name, `wget -qO- http://127.0.0.1:${port}/`);

    expect(listed).toContain('imp-e2e-laptop (ED25519)');
    expect(listedOwn).toContain('imp-e2e-laptop (ED25519)');
    expect(modes).toBe('dev 600\ndev 600\ndev 700');
    expect(`${fetched}\n`).toBe(PAGE);
  } finally {
    const code = await reverse.stop();

    expect(code).toBe(0);
  }

  await waitGone(socket);
  await waitGone(dirname(reverse.guests[2] ?? ''));
});

// A forced sleep ends the forward in the imp. The CLI leaves the imp asleep,
// and once it wakes listens again at the same path, over the old socket.
test('a forward listens again at the same path once the imp wakes', async () => {
  const socket = '/tmp/e2e-again.sock';

  const reverse = await startReverse(`${socket}:${laptop.socket}`);

  try {
    await runImp('sleep', name);

    await waitFor('the CLI to see the forward end', () => {
      if (!reverse.readStderr().includes('listening again once')) {
        throw new Error(`imp proxy said ${reverse.readStderr()}`);
      }
    });

    // the CLI must not wake the imp it waits on
    await Bun.sleep(3000);

    const asleep = await readState(name);

    expect(asleep).toBe('sleeping');

    await runImp('wake', name);
    await holdImp(name);

    await waitFor('the forward to listen again', () => {
      if (
        !reverse.readStderr().includes(`forwarding ${name}:${socket} -> ${laptop.socket} again`)
      ) {
        throw new Error(`imp proxy said ${reverse.readStderr()}`);
      }
    });

    const listed = await listKeys(socket);

    expect(listed).toContain('imp-e2e-laptop (ED25519)');
  } finally {
    await reverse.stop();
  }
});

// An open relay keeps the imp awake, as a tunnel does; the listener alone
// does not, and the imp then sleeps on its idle timeout.
test('an open relay keeps the imp awake, and the listener alone does not', async () => {
  const reverse = await startReverse(`0:${String(holderPort)}`);

  try {
    const [port = ''] = reverse.guests;

    await runShellInImp(
      name,
      `setsid sh -c 'sleep 3600 | nc 127.0.0.1 ${port} > /tmp/held.out' >/dev/null 2>&1 &`,
    );

    await waitFor('the held relay', async () => {
      const out = await runShellInImp(name, 'cat /tmp/held.out');

      if (out !== 'held') {
        throw new Error(`the relay said ${out}`);
      }
    });

    await runImp('hold', name, '0');

    await Bun.sleep((config.idleTimeoutS + 10) * 1000);

    const awake = await readState(name);

    expect(awake).toBe('running');

    await runShellInImp(name, 'pkill nc || true');

    await waitFor('the imp to sleep', () => assertState(name, 'sleeping'), {
      timeoutMs: (config.idleTimeoutS + 60) * 1000,
    });
  } finally {
    await reverse.stop();

    await runImp('wake', name);
    await holdImp(name);
  }
}, 180_000);

function waitForLog(stderr: ReadableStream<Uint8Array>, text: string): Promise<string> {
  const sink = { text: '' };

  void collectOutput(stderr, sink);

  return waitFor(`ssh to say ${text}`, () => {
    if (!sink.text.includes(text)) {
      throw new Error(`ssh said ${sink.text}`);
    }

    return sink.text;
  });
}

test('ssh -R forwards a port and a unix socket in the imp to this machine', async () => {
  const socket = '/tmp/e2e-ssh-r.sock';

  const forward = startSsh(client, [
    '-N',
    '-o',
    'LogLevel=INFO',
    '-o',
    'ExitOnForwardFailure=yes',
    '-R',
    `0:127.0.0.1:${String(page.port)}`,
    '-R',
    `${socket}:${laptop.socket}`,
    `${name}@${SSH_HOST}`,
  ]);

  try {
    const log = await waitForLog(forward.proc.stderr, 'Allocated port');

    const port = /Allocated port (?<port>\d+) for remote forward/v.exec(log)?.groups?.['port'];

    expect(port).toBeDefined();

    await waitFor('the socket forward', async () => {
      const state = await checkExists(socket);

      if (state !== 'there') {
        throw new Error(`no ${socket} yet`);
      }
    });

    const fetched = await runShellInImp(name, `wget -qO- http://127.0.0.1:${port ?? ''}/`);
    const listed = await listKeys(socket);

    expect(`${fetched}\n`).toBe(PAGE);
    expect(listed).toContain('imp-e2e-laptop (ED25519)');
  } finally {
    await forward.stop();
  }

  await waitGone(socket);
});

test('ssh -R to a privileged port is refused', async () => {
  const forward = startSsh(client, [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-R',
    `80:127.0.0.1:${String(page.port)}`,
    `${name}@${SSH_HOST}`,
  ]);

  const code = await forward.proc.exited;

  const stderr = await new Response(forward.proc.stderr).text();

  expect(code).not.toBe(0);
  expect(stderr).toContain('remote port forwarding failed for listen port 80');
});
