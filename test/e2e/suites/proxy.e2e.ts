import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { resolveImageName } from '../lib/fixtures';
import { requireImp, runShellInImp, tryImp } from '../lib/imp-cli';
import {
  GUEST_SERVERS,
  PAGE,
  countMatches,
  openHeldSocket,
  readPage,
  sendRequest,
  startProxy,
} from '../lib/imp-proxy';
import type { HeldSocket, RunningProxy } from '../lib/imp-proxy';
import { createImp } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// `imp proxy`: local ports to ports in an imp, over impd's /tunnel. The
// cases that wait out the idle timeout are in proxy-wake.

const prefix = setupSuite('proxy');
const name = `${prefix}a`;

// impd's cap on open tunnels per imp
const MAX_TUNNELS = 256;
let proxy: RunningProxy;

beforeAll(async () => {
  await createImp(name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');
  await runShellInImp(name, GUEST_SERVERS);

  proxy = await startProxy(name, '0:8080', '0:9001', '0:9002');
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
