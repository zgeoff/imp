import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, requireImp, runImp, runShellInImp, startImp, tryImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// `imp proxy`: local ports to ports in an imp, over impd's /tunnel.

const prefix = setupSuite('proxy');
const name = `${prefix}a`;

// the idle timeout plus a sweep of the idle loop
const ASLEEP_WITHIN_MS = (config.idleTimeoutS + 15) * 1000;

// long enough that only activity keeps an imp awake
const PAST_IDLE_MS = (config.idleTimeoutS + 6) * 1000;

// impd's cap on open tunnels per imp
const MAX_TUNNELS = 256;
const PAGE = 'e2e-tiny-ok\n';

// In the guest, on its loopback only: httpd on 9001, and on 9002 a server
// that answers only once the client half-closed, with the bytes it read.
const GUEST_SERVERS = [
  'httpd -p 127.0.0.1:9001 -h /srv/www',
  String.raw`printf '#!/bin/sh\necho "got $(wc -c) bytes"\n' > /tmp/count`,
  'chmod +x /tmp/count',
  'setsid nc -lk -p 9002 -s 127.0.0.1 -e /tmp/count >/dev/null 2>&1 &',
].join('\n');

const decoder = new TextDecoder();

interface RunningProxy {
  // the local port of each forward, in order
  readonly ports: readonly number[];
  readonly readStderr: () => string;
  readonly stop: () => Promise<number>;
}

interface OutputSink {
  text: string;
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- the sink collects
async function collectOutput(stream: ReadableStream<Uint8Array>, sink: OutputSink): Promise<void> {
  for await (const chunk of stream) {
    sink.text += decoder.decode(chunk);
  }
}

// `imp proxy <name> <specs>`, once it printed a line for every forward
async function startProxy(...specs: readonly string[]): Promise<RunningProxy> {
  const proc = await startImp(['proxy', name, ...specs]);

  const stderr = { text: '' };
  const stdout = { text: '' };

  void collectOutput(proc.stderr, stderr);
  void collectOutput(proc.stdout, stdout);

  const ports = await waitFor('imp proxy to listen', () => {
    const found = [...stdout.text.matchAll(/forwarding localhost:(?<port>\d+) ->/gv)];

    if (found.length < specs.length) {
      throw new Error(`imp proxy printed ${stdout.text}${stderr.text}`);
    }

    return found.map((match) => Number(match.groups?.['port']));
  });

  return {
    ports,
    readStderr: () => stderr.text,
    stop: () => {
      proc.kill('SIGINT');

      return proc.exited;
    },
  };
}

function waitAsleep(): Promise<void> {
  return waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: ASLEEP_WITHIN_MS,
  });
}

// sends `body`, half-closes, and resolves with the reply once the far end
// closed
function sendRequest(port: number, body: string): Promise<string> {
  const reply = Promise.withResolvers<string>();
  const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  let text = '';

  socket.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });

  socket.on('error', reply.reject);

  socket.on('close', () => {
    reply.resolve(text);
  });

  socket.end(body);

  return reply.promise;
}

interface HeldSocket {
  readonly socket: Socket;
  readonly closed: Promise<void>;
}

async function openHeldSocket(port: number): Promise<HeldSocket> {
  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port }, connected.resolve);

  socket.on('error', () => {
    // a reset shows as the close
  });

  socket.on('close', () => {
    closed.resolve();
  });

  await connected.promise;

  return { socket, closed: closed.promise };
}

async function readPage(url: string): Promise<string> {
  const response = await fetch(url);

  return response.text();
}

function countMatches(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

let proxy: RunningProxy;

beforeAll(async () => {
  await createImp(name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');
  await runShellInImp(name, GUEST_SERVERS);

  proxy = await startProxy('0:8080', '0:9001', '0:9002');
}, 120_000);

afterAll(async () => {
  const code = await proxy.stop();

  expect(code).toBe(0);
});

test('a busy local port fails at once, and so does a missing imp', async () => {
  const busy: Server = createServer();
  const listening = Promise.withResolvers<void>();

  busy.listen(0, '127.0.0.1', listening.resolve);

  await listening.promise;

  const address = busy.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    const inUse = await tryImp(['proxy', name, `${String(port)}:8080`]);
    const missing = await tryImp(['proxy', `${prefix}nope`, '0:8080']);

    expect(inUse.exitCode).toBe(1);
    expect(inUse.stderr).toContain(`local port ${String(port)} is in use; map another one`);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('NOT_FOUND');
  } finally {
    busy.close();
  }
});

test('a request reaches the http service on both loopbacks', async () => {
  const port = String(proxy.ports[0]);

  const overLocalhost = await readPage(`http://localhost:${port}/`);
  const overIpv4 = await readPage(`http://127.0.0.1:${port}/`);
  const overIpv6 = await readPage(`http://[::1]:${port}/`);

  expect([overLocalhost, overIpv4, overIpv6]).toEqual([PAGE, PAGE, PAGE]);
});

test("a server on the guest's loopback only is reachable", async () => {
  const page = await readPage(`http://127.0.0.1:${String(proxy.ports[1])}/`);

  expect(page).toBe(PAGE);
});

test('a client that half-closes still gets the reply', async () => {
  const reply = await sendRequest(proxy.ports[2] ?? 0, 'hello');

  expect(reply).toBe('got 5 bytes\n');
});

test('an imp with an agent too old to dial gets AGENT_OUTDATED', async () => {
  const imp = await requireImp(name);

  const file = `/var/lib/imp/imps/${imp.id}/vm.json`;

  await runInContainer([
    'sh',
    '-c',
    `cp ${file} ${file}.e2e && sed -i 's/"agentVersion": "[^"]*"/"agentVersion": "0.1.0"/' ${file}`,
  ]);

  try {
    const reply = await sendRequest(proxy.ports[0] ?? 0, 'GET / HTTP/1.0\r\n\r\n').catch(String);

    expect(reply).not.toContain('e2e-tiny-ok');

    await waitFor('the AGENT_OUTDATED notice', () => {
      expect(proxy.readStderr()).toContain(`${name}:8080: AGENT_OUTDATED`);
    });
  } finally {
    await runInContainer(['mv', `${file}.e2e`, file]);
  }
});

test('the connection past the cap is refused with TUNNEL_LIMIT, and a closed one frees a place', async () => {
  const before = countMatches(proxy.readStderr(), 'TUNNEL_LIMIT');
  const held: HeldSocket[] = [];

  try {
    for (let index = 0; index <= MAX_TUNNELS; index++) {
      const socket = await openHeldSocket(proxy.ports[0] ?? 0);

      held.push(socket);
    }

    await waitFor('the TUNNEL_LIMIT notice', () => {
      expect(countMatches(proxy.readStderr(), 'TUNNEL_LIMIT')).toBe(before + 1);
    });

    // the rest stay open: exactly one was refused
    await Bun.sleep(1000);

    expect(countMatches(proxy.readStderr(), 'TUNNEL_LIMIT')).toBe(before + 1);
  } finally {
    for (const entry of held) {
      entry.socket.destroy();
    }
  }

  const page = await waitFor('a tunnel after the held ones closed', () =>
    readPage(`http://127.0.0.1:${String(proxy.ports[0])}/`),
  );

  expect(page).toBe(PAGE);
}, 120_000);

test('an open connection keeps the imp awake, and it sleeps once the connection ends', async () => {
  const held = await openHeldSocket(proxy.ports[1] ?? 0);

  try {
    await Bun.sleep(PAST_IDLE_MS);

    await assertState(name, 'running');
  } finally {
    held.socket.destroy();
  }

  await waitAsleep();
}, 120_000);

test('a connection wakes a sleeping imp', async () => {
  await assertState(name, 'sleeping');

  const started = Date.now();

  const page = await readPage(`http://127.0.0.1:${String(proxy.ports[0])}/`);

  writeMetric('proxyWakeMs', Date.now() - started);

  expect(page).toBe(PAGE);

  await assertState(name, 'running');
});

test('a forced sleep drops open connections, and the next connection wakes the imp', async () => {
  const held = await openHeldSocket(proxy.ports[2] ?? 0);

  await runImp('sleep', name);
  await held.closed;

  await waitFor('the lost notice', () => {
    expect(proxy.readStderr()).toContain(`${name}:9002: the connection in the imp was lost`);
  });

  const reply = await sendRequest(proxy.ports[2] ?? 0, 'again');

  expect(reply).toBe('got 5 bytes\n');

  await assertState(name, 'running');
}, 120_000);
