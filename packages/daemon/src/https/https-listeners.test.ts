import { expect, test } from 'bun:test';
import { connect } from 'node:tls';
import { setupImpTest } from '../imps/test-imps';
import { findFreePorts } from '../net/test-free-ports';
import { createForwardedPeers } from '../proxy/forwarded-peers';
import { startWakeProxy } from '../proxy/wake-proxy';
import { readRejection } from '../read-rejection';
import { createHttpsListeners } from './https-listeners';
import { createTestCertificate } from './test-certificates';

const DOMAIN = 'imp.test';
const NAMES = [DOMAIN, `*.${DOMAIN}`];

// free ports; `slots` is slot 0's, the slot the test's imp takes
function pickPorts() {
  const ports = findFreePorts(5);

  return {
    api: ports.take(),
    proxy: ports.take(),
    https: ports.take(),
    http: ports.take(),
    slots: ports.take(),
  };
}

// impd's API, as the bare domain reaches it: echoes what it was sent, and
// echoes WebSocket messages
function startFakeApi(port: number) {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: (request, server) => {
      if (request.headers.get('upgrade') === 'websocket') {
        return server.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
      }

      return Response.json({
        path: new URL(request.url).pathname,
        proto: request.headers.get('x-forwarded-proto'),

        // the dashboard's same-origin check compares the Origin with this
        host: new URL(request.url).host,
        cookie: request.headers.get('cookie'),
      });
    },
    websocket: {
      message: (ws, message) => {
        ws.send(message);
      },
    },
  });
}

async function setup() {
  const ports = pickPorts();

  const ctx = await setupImpTest({
    env: {
      IMP_API_PORT: String(ports.api),
      IMP_PROXY_PORT: String(ports.proxy),
      IMP_PORT_BASE: String(ports.slots),
      IMP_SUBNET: '10.99.0.0/28',
    },
  });

  const api = startFakeApi(ports.api);

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  const logs: string[] = [];

  const listeners = createHttpsListeners({
    proxy,
    domain: DOMAIN,
    httpsPort: ports.https,
    httpPort: ports.http,
    log: (message) => {
      logs.push(message);
    },
  });

  // an imp whose address is the fake API's, so a request to it shows what
  // the imp would get
  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'web', httpPort: ports.api });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  return {
    ports,
    listeners,
    logs,
    [Symbol.asyncDispose]: async () => {
      await listeners.stop();
      await proxy.stop();
      await api.stop(true);
      await ctx[Symbol.asyncDispose]();
    },
  };
}

function readTls(port: number, host: string, path = '/') {
  return fetch(`https://127.0.0.1:${String(port)}${path}`, {
    headers: { host },
    redirect: 'manual',
    tls: { rejectUnauthorized: false },
    signal: AbortSignal.timeout(5000),
  });
}

// the CN of the certificate a new TLS connection gets
function readPeerName(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host: '127.0.0.1', port, servername: `box.${DOMAIN}`, rejectUnauthorized: false },
      () => {
        resolve(String(socket.getPeerCertificate().subject.CN));

        socket.end();
      },
    );

    socket.on('error', reject);
  });
}

test('nothing listens before the first certificate', async () => {
  await using ctx = await setup();

  ctx.listeners.setAddresses(['127.0.0.1']);

  const error = await readRejection(readTls(ctx.ports.https, DOMAIN));

  expect(error).not.toBeNull();
});

test('the bare domain reaches the API over https, and only one label names an imp', async () => {
  await using ctx = await setup();

  const certificate = await createTestCertificate({ names: NAMES });

  ctx.listeners.setAddresses(['127.0.0.1']);
  ctx.listeners.setCertificate(certificate);

  const apex = await readTls(ctx.ports.https, DOMAIN, '/health');
  const apexBody: unknown = await apex.json();

  expect(apexBody).toEqual({ path: '/health', proto: 'https', host: DOMAIN, cookie: null });

  // `imp.imp.test` is the imp named imp, which does not exist
  const imp = await readTls(ctx.ports.https, `imp.${DOMAIN}`);
  const impBody = await imp.text();

  expect(imp.status).toBe(404);
  expect(impBody).toContain('There is no imp named imp.');

  const nested = await readTls(ctx.ports.https, `a.b.${DOMAIN}`);
  const nestedBody = await nested.text();

  expect(nested.status).toBe(404);
  expect(nestedBody).toContain('Use https://&lt;imp&gt;.imp.test/.');

  const other = await readTls(ctx.ports.https, 'box.imp.localhost');

  expect(other.status).toBe(404);
});

test('the API on the bare domain gets the dashboard session, and an imp never does', async () => {
  await using ctx = await setup();

  const certificate = await createTestCertificate({ names: NAMES });

  ctx.listeners.setAddresses(['127.0.0.1']);
  ctx.listeners.setCertificate(certificate);

  const cookie = 'a=1; __Host-imp_session=v1.2.secret; imp_session=v1.2.plain';

  const send = async (host: string) => {
    const response = await fetch(`https://127.0.0.1:${String(ctx.ports.https)}/`, {
      headers: { host, cookie },
      tls: { rejectUnauthorized: false },
      signal: AbortSignal.timeout(5000),
    });

    const body: unknown = await response.json();

    return body;
  };

  const apex = await send(DOMAIN);
  const imp = await send(`web.${DOMAIN}`);

  expect(apex).toMatchObject({ cookie });
  expect(imp).toMatchObject({ host: `web.${DOMAIN}`, cookie: 'a=1' });
});

test('plain http on the domain redirects to https, and wakes nothing', async () => {
  await using ctx = await setup();

  const certificate = await createTestCertificate({ names: NAMES });

  ctx.listeners.setAddresses(['127.0.0.1']);
  ctx.listeners.setCertificate(certificate);

  const response = await fetch(`http://127.0.0.1:${String(ctx.ports.http)}/a/b?c=d`, {
    headers: { host: `Box.${DOMAIN}` },
    redirect: 'manual',
  });

  expect(response.status).toBe(308);

  expect(response.headers.get('location')).toBe(
    `https://box.${DOMAIN}:${String(ctx.ports.https)}/a/b?c=d`,
  );

  const unknown = await fetch(`http://127.0.0.1:${String(ctx.ports.http)}/`, {
    headers: { host: 'evil.example' },
    redirect: 'manual',
  });

  expect(unknown.status).toBe(404);
});

test('a new certificate serves new connections while an open WebSocket stays up', async () => {
  await using ctx = await setup();

  const first = await createTestCertificate({ names: ['first.test', ...NAMES] });
  const second = await createTestCertificate({ names: ['second.test', ...NAMES] });

  ctx.listeners.setAddresses(['127.0.0.1']);
  ctx.listeners.setCertificate(first);

  const before = await readPeerName(ctx.ports.https);

  expect(before).toBe('first.test');

  const socket = new WebSocket(`wss://127.0.0.1:${String(ctx.ports.https)}/`, {
    headers: { host: DOMAIN },
    tls: { rejectUnauthorized: false },
  });

  const messages: string[] = [];

  socket.addEventListener('message', (event) => {
    messages.push(String(event.data));
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });

  ctx.listeners.setCertificate(second);

  // SO_REUSEPORT would spread new connections over both listeners if the
  // old one still took any
  for (let index = 0; index < 5; index += 1) {
    const after = await readPeerName(ctx.ports.https);

    expect(after).toBe('second.test');
  }

  socket.send('still here');

  await waitUntil(() => messages.length > 0);

  expect(messages).toEqual(['still here']);
  expect(socket.readyState).toBe(WebSocket.OPEN);

  socket.close();
});

test('an address that goes away stops being served', async () => {
  await using ctx = await setup();

  const certificate = await createTestCertificate({ names: NAMES });

  ctx.listeners.setAddresses(['127.0.0.1']);
  ctx.listeners.setCertificate(certificate);

  const served = await readTls(ctx.ports.https, DOMAIN);

  expect(served.ok).toBe(true);

  ctx.listeners.setAddresses([]);

  await Bun.sleep(50);

  const error = await readRejection(readTls(ctx.ports.https, DOMAIN));

  expect(error).not.toBeNull();
});

test('an address it cannot bind is logged once and tried again', async () => {
  await using ctx = await setup();

  const certificate = await createTestCertificate({ names: NAMES });

  // TEST-NET-1: no interface has it
  ctx.listeners.setCertificate(certificate);
  ctx.listeners.setAddresses(['192.0.2.1']);
  ctx.listeners.setAddresses(['192.0.2.1']);

  const failures = ctx.logs.filter((line) => line.includes(`192.0.2.1:${String(ctx.ports.https)}`));

  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain('cannot listen');
});

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await Bun.sleep(10);
  }
}
