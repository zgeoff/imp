import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:tls';
import { findPublicImp } from '../db/exposure';
import { findImpByName, updateImpExposure } from '../db/imps';
import { createImpTest } from '../imps/test-imps';
import { createForwardedPeers } from '../proxy/forwarded-peers';
import { startWakeProxy } from '../proxy/wake-proxy';
import { readRejection } from '../read-rejection';
import { findFreePorts } from '../test-utils/find-free-ports';
import { createHttpsListeners } from './https-listeners';
import type { ListenerScope } from './https-listeners';
import { buildCredentialHash, createPublicScope } from './public-auth';
import { createPublicLimits } from './public-limits';
import { createTestCertificate } from './test-certificates';

const DOMAIN = 'imp.test';
const NAMES = [DOMAIN, `*.${DOMAIN}`];

// free ports; `slots` is slot 0's, the slot the test's imp takes
// the slots of 10.99.0.0/28
const SLOT_COUNT = 4;

// impd refuses an API or proxy port among the imp ports, so a pick there is
// made again
function pickPorts(): Readonly<Record<'api' | 'proxy' | 'https' | 'http' | 'slots', number>> {
  const ports = findFreePorts(5);

  const picked = {
    api: ports.take(),
    proxy: ports.take(),
    https: ports.take(),
    http: ports.take(),
    slots: ports.take(),
  };

  const isAmongSlots = (port: number) => port >= picked.slots && port < picked.slots + SLOT_COUNT;

  return isAmongSlots(picked.api) || isAmongSlots(picked.proxy) ? pickPorts() : picked;
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
        authorization: request.headers.get('authorization'),
        forwardedFor: request.headers.get('x-forwarded-for'),
        forwarded: request.headers.get('forwarded'),
        realIp: request.headers.get('x-real-ip'),
        forwardedHost: request.headers.get('x-forwarded-host'),
      });
    },
    websocket: {
      message: (ws, message) => {
        ws.send(message);
      },
    },
  });
}

async function setup(scopeKind: ListenerScope['kind'] = 'tailnet') {
  const ports = pickPorts();

  // the listeners, proxy and fake API stop before the harness closes its
  // database
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await createImpTest(stack, {
    env: {
      IMP_API_PORT: String(ports.api),
      IMP_PROXY_PORT: String(ports.proxy),
      IMP_PORT_BASE: String(ports.slots),
      IMP_SUBNET: '10.99.0.0/28',
    },
  });

  const api = startFakeApi(ports.api);

  stack.defer(() => api.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  stack.defer(() => proxy.stop());

  const logs: string[] = [];

  // the public limits, so a test can see what a request took
  const limits = createPublicLimits();

  const scope: ListenerScope =
    scopeKind === 'tailnet'
      ? { kind: 'tailnet' }
      : createPublicScope((name) => findPublicImp(ctx.db, name), limits);

  const listeners = createHttpsListeners({
    proxy,
    domain: DOMAIN,
    httpsPort: ports.https,
    httpPort: ports.http,
    log: (message) => {
      logs.push(message);
    },
    scope,
  });

  stack.defer(() => listeners.stop());

  // an imp whose address is the fake API's, so a request to it shows what
  // the imp would get
  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'web', httpPort: ports.api });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  // public with this auth, its credential `secret-credential`
  const updateWebExposure = async (auth: 'none' | 'token' | 'basic') => {
    await updateImpExposure(ctx.db, imp.id, {
      auth,
      user: auth === 'basic' ? 'ann' : null,
      hash: auth === 'none' ? null : buildCredentialHash('secret-credential'),
    });
  };

  const readWebState = async () => {
    const web = await findImpByName(ctx.db, 'web');

    return web?.state;
  };

  return {
    ports,
    listeners,
    logs,
    updateWebExposure,
    readWebState,
    limits,
    readWebId: () => imp.id,
    sleepWeb: () => ctx.imps.sleepImp('web'),

    // the imp's HTTP port to one nothing listens on
    breakWeb: () =>
      ctx.db.updateTable('imps').set({ http_port: 1 }).where('id', '=', imp.id).execute(),
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
  const ctx = await setup();

  ctx.listeners.setAddresses(['127.0.0.1']);

  const error = await readRejection(readTls(ctx.ports.https, DOMAIN));

  expect(error).not.toBeNull();
});

test('the bare domain reaches the API over https, and only one label names an imp', async () => {
  const ctx = await setup();
  const certificate = await createTestCertificate({ names: NAMES });

  ctx.listeners.setAddresses(['127.0.0.1']);
  ctx.listeners.setCertificate(certificate);

  const apex = await readTls(ctx.ports.https, DOMAIN, '/health');
  const apexBody: unknown = await apex.json();

  expect(apexBody).toEqual({
    path: '/health',
    proto: 'https',
    host: DOMAIN,
    cookie: null,
    authorization: null,
    forwardedFor: '127.0.0.1',
    forwarded: null,
    realIp: null,
    forwardedHost: DOMAIN,
  });

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
  const ctx = await setup();
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
  const ctx = await setup();
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
  const ctx = await setup();
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
  const ctx = await setup();
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
  const ctx = await setup();
  const certificate = await createTestCertificate({ names: NAMES });

  // TEST-NET-1: no interface has it
  ctx.listeners.setCertificate(certificate);
  ctx.listeners.setAddresses(['192.0.2.1']);
  ctx.listeners.setAddresses(['192.0.2.1']);

  const failures = ctx.logs.filter((line) => line.includes(`192.0.2.1:${String(ctx.ports.https)}`));

  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain('cannot listen');
});

// the public listeners, serving with a certificate on loopback
async function setupPublic() {
  const ctx = await setup('public');

  ctx.listeners.setAddresses(['127.0.0.1']);

  const certificate = await createTestCertificate({ names: NAMES });

  ctx.listeners.setCertificate(certificate);

  return ctx;
}

test('a tailnet-only imp is a 404 on the public listener, whatever the Host says', async () => {
  const ctx = await setupPublic();

  await ctx.sleepWeb();

  for (const host of [`web.${DOMAIN}`, `WEB.${DOMAIN}.`, `web.${DOMAIN}:443`, DOMAIN]) {
    const response = await readTls(ctx.ports.https, host);
    const body = await response.text();

    expect({ host, status: response.status }).toEqual({ host, status: 404 });
    expect(body).toContain('No public imp here.');
  }

  const unknown = await readTls(ctx.ports.https, `nope.${DOMAIN}`);
  const unknownBody = await unknown.text();

  // the same page as for an imp that does not exist: nothing tells them apart
  expect(unknown.status).toBe(404);
  expect(unknownBody).toContain('No public imp here.');

  const redirect = await fetch(`http://127.0.0.1:${String(ctx.ports.http)}/`, {
    headers: { host: `web.${DOMAIN}` },
    redirect: 'manual',
  });

  expect(redirect.status).toBe(404);

  const state = await ctx.readWebState();

  expect(state).toBe('sleeping');
});

test('a public imp without auth is served, and plain http redirects to port 443', async () => {
  const ctx = await setupPublic();

  await ctx.updateWebExposure('none');

  const response = await readTls(ctx.ports.https, `web.${DOMAIN}`, '/x');
  const body: unknown = await response.json();

  expect(body).toMatchObject({ path: '/x', proto: 'https', host: `web.${DOMAIN}` });

  const redirect = await fetch(`http://127.0.0.1:${String(ctx.ports.http)}/a?b=c`, {
    headers: { host: `web.${DOMAIN}` },
    redirect: 'manual',
  });

  expect(redirect.status).toBe(308);
  expect(redirect.headers.get('location')).toBe(`https://web.${DOMAIN}/a?b=c`);

  // the bare domain is impd's API on the tailnet, never on the internet
  const apex = await readTls(ctx.ports.https, DOMAIN);

  expect(apex.status).toBe(404);
});

test('a token imp asks for its token before the wake, and never forwards it', async () => {
  const ctx = await setupPublic();

  await ctx.updateWebExposure('token');
  await ctx.sleepWeb();

  for (const authorization of [null, 'Bearer wrong', 'Basic c2VjcmV0LWNyZWRlbnRpYWw=']) {
    const response = await fetch(`https://127.0.0.1:${String(ctx.ports.https)}/`, {
      headers: {
        host: `web.${DOMAIN}`,
        ...(authorization !== null && { authorization }),
      },
      tls: { rejectUnauthorized: false },
    });

    expect({ authorization, status: response.status }).toEqual({ authorization, status: 401 });
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="web", charset="UTF-8"');
  }

  const state = await ctx.readWebState();

  expect(state).toBe('sleeping');

  const response = await fetch(`https://127.0.0.1:${String(ctx.ports.https)}/`, {
    headers: { host: `web.${DOMAIN}`, authorization: 'Bearer secret-credential' },
    tls: { rejectUnauthorized: false },
  });

  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({ host: `web.${DOMAIN}`, authorization: null });
});

test('a basic auth imp takes its user and password, and nothing else', async () => {
  const ctx = await setupPublic();

  await ctx.updateWebExposure('basic');

  const send = (credentials: string) =>
    fetch(`https://127.0.0.1:${String(ctx.ports.https)}/`, {
      headers: {
        host: `web.${DOMAIN}`,
        authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
      },
      tls: { rejectUnauthorized: false },
    });

  const wrongUser = await send('bob:secret-credential');
  const wrongPassword = await send('ann:secret');

  expect([wrongUser.status, wrongPassword.status]).toEqual([401, 401]);
  expect(wrongUser.headers.get('www-authenticate')).toBe('Basic realm="web", charset="UTF-8"');

  const right = await send('ann:secret-credential');
  const body: unknown = await right.json();

  expect(body).toMatchObject({ authorization: null });
});

test('plain http on the public listener takes no slot and no wake', async () => {
  const ctx = await setupPublic();

  await ctx.updateWebExposure('none');
  await ctx.sleepWeb();

  // more than the 64 slots and the 10 wakes
  for (let index = 0; index < 100; index += 1) {
    const redirect = await fetch(`http://127.0.0.1:${String(ctx.ports.http)}/`, {
      headers: { host: `web.${DOMAIN}` },
      redirect: 'manual',
    });

    expect(redirect.status).toBe(308);
  }

  const id = ctx.readWebId();
  const releases = Array.from({ length: 64 }, () => ctx.limits.tryOpen(id));
  const wakes = Array.from({ length: 10 }, () => ctx.limits.tryWake(id));

  expect(releases.every((release) => release !== null)).toBe(true);
  expect(wakes.every(Boolean)).toBe(true);

  for (const release of releases) {
    release?.();
  }
});

test('a WebSocket upgrade without the token gets a 401 and wakes nothing', async () => {
  const ctx = await setupPublic();

  await ctx.updateWebExposure('token');
  await ctx.sleepWeb();

  const response = await fetch(`https://127.0.0.1:${String(ctx.ports.https)}/`, {
    headers: {
      host: `web.${DOMAIN}`,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',

      // any 16 bytes, base64
      'sec-websocket-key': Buffer.from('imp-test-socket!').toString('base64'),
    },
    tls: { rejectUnauthorized: false },
  });

  const state = await ctx.readWebState();

  expect(response.status).toBe(401);
  expect(state).toBe('sleeping');
});

test('the public listener names nothing in its errors, and resets X-Forwarded-For', async () => {
  const ctx = await setupPublic();

  await ctx.updateWebExposure('none');

  const forwarded = await fetch(`https://127.0.0.1:${String(ctx.ports.https)}/`, {
    headers: {
      host: `web.${DOMAIN}`,
      'x-forwarded-for': '198.51.100.9',
      forwarded: 'for=198.51.100.9;proto=http',
      'x-real-ip': '198.51.100.9',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
    },
    tls: { rejectUnauthorized: false },
  });

  const body: unknown = await forwarded.json();

  expect(body).toMatchObject({
    forwardedFor: '127.0.0.1',
    forwarded: null,
    realIp: null,
    forwardedHost: `web.${DOMAIN}`,
    proto: 'https',
  });

  await ctx.breakWeb();

  const broken = await readTls(ctx.ports.https, `web.${DOMAIN}`);
  const page = await broken.text();

  expect(broken.status).toBe(502);
  expect(page).toContain('This site did not answer.');
  expect(page).not.toContain('port 1');
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
