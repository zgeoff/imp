import { expect, test } from 'bun:test';
import { removeImp } from '../db/imps';
import { setupImpTest } from '../imps/test-imps';
import { findFreePorts } from '../net/test-free-ports';
import { PEER_HEADER, createForwardedPeers } from './forwarded-peers';
import { startWakeProxy } from './wake-proxy';

// free ports for the proxy and slot 0, the slot each test's imp takes
function pickPorts() {
  const ports = findFreePorts(2);

  return {
    IMP_PROXY_PORT: String(ports.take()),
    IMP_PORT_BASE: String(ports.take()),
    IMP_SUBNET: '10.99.0.0/24',
  };
}

// True when this proxy still serves `name` on the port. The answer names the
// imp: random ports can collide with another process on a busy host, and one
// that merely listens there must not count.
async function isServingImp(port: number, name: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      signal: AbortSignal.timeout(5000),
    });

    const body = await response.text();

    return body.includes(`There is no imp named ${name}.`);
  } catch {
    return false;
  }
}

test('overlapping listener syncs end with the listeners the database holds', async () => {
  const ports = pickPorts();

  await using ctx = await setupImpTest({ env: ports });

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  try {
    await ctx.createTestImage('ubuntu');

    // a listener for `old`, then `old` goes and `new` takes its slot
    const old = await ctx.imps.createImp({ name: 'old' });

    await proxy.syncListeners();

    await removeImp(ctx.db, old.id);

    const fresh = await ctx.imps.createImp({ name: 'new' });

    // the first pass reads `new`, then waits on stopping old's listener; the
    // second reads after `new` is gone too
    const first = proxy.syncListeners();

    await removeImp(ctx.db, fresh.id);

    const second = proxy.syncListeners();

    await Promise.all([first, second]);

    const listening = await isServingImp(Number(ports.IMP_PORT_BASE) + fresh.slot, 'new');

    expect(listening).toBe(false);
  } finally {
    await proxy.stop();
  }
});

// An upstream on 127.0.0.1 that records the Cookie header of each request
// and WebSocket upgrade, with an imp whose address points at it.
async function setupCookieTest() {
  const cookies: (string | null)[] = [];

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, server) => {
      cookies.push(request.headers.get('cookie'));

      // Bun ends a request it upgraded with no response
      if (server.upgrade(request)) {
        // oxlint-disable-next-line unicorn/no-useless-undefined
        return undefined;
      }

      return new Response('ok');
    },
    websocket: {
      message: (ws, message) => {
        ws.send(message);
      },
    },
  });

  const ports = pickPorts();

  const ctx = await setupImpTest({ env: ports });

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  return {
    cookies,
    port: Number(ports.IMP_PORT_BASE) + imp.slot,
    async [Symbol.asyncDispose]() {
      await proxy.stop();
      await upstream.stop(true);
      await ctx[Symbol.asyncDispose]();
    },
  };
}

test('the proxy keeps the dashboard session cookie from an imp over HTTP', async () => {
  await using ctx = await setupCookieTest();

  const response = await fetch(`http://127.0.0.1:${String(ctx.port)}/`, {
    headers: { cookie: 'a=1; imp_session=v1.2.secret; __Host-imp_session=v1.2.secret; b=2' },
  });

  await response.text();

  expect(ctx.cookies).toEqual(['a=1; b=2']);
});

test('the proxy keeps the dashboard session cookie from an imp over a WebSocket', async () => {
  await using ctx = await setupCookieTest();

  const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.port)}/`, {
    headers: { cookie: 'a=1; imp_session=v1.2.secret' },
  });

  const opened = await new Promise<string>((resolve) => {
    socket.addEventListener('open', () => {
      resolve('open');
    });

    socket.addEventListener('error', () => {
      resolve('error');
    });
  });

  socket.close();

  expect(opened).toBe('open');
  expect(ctx.cookies).toEqual(['a=1']);
});

test('the API route hands a peer handle only to the paths that resolve a caller', async () => {
  const seen: (string | null)[] = [];

  // impd's API, as far as the proxy can tell
  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      seen.push(request.headers.get(PEER_HEADER));

      return new Response('ok');
    },
  });

  const ports = pickPorts();

  await using ctx = await setupImpTest({
    env: { ...ports, IMP_API_PORT: String(api.port) },
  });

  const registered: string[] = [];

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: () => {},
    peers: {
      register: (address) => {
        registered.push(address);

        return 'handle';
      },
      take: () => null,
    },
  });

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  try {
    const base = `http://127.0.0.1:${String(apex.port)}`;
    const forged = { [PEER_HEADER]: 'forged' };

    // a flood of page loads takes no handle, and a forged one never passes
    for (const path of ['/ui/', '/ui/assets/app.js', '/health', '/rpcx']) {
      await fetch(`${base}${path}`, { headers: forged });
    }

    await fetch(`${base}/rpc/system/info`, { method: 'POST', headers: forged });

    expect(registered).toHaveLength(1);
    expect(seen).toEqual([null, null, null, null, 'handle']);
  } finally {
    await apex.stop(true);
    await proxy.stop();
    await api.stop(true);
  }
});

// What `tailscale serve` sends for a per-imp name (docs/guides/tailscale.md):
// the service's Host, its own forwarding headers and the member's login. On
// the imp's own port every one goes to the imp, never to impd's API.
test('a request on an imp’s port goes to the imp whatever its Host says', async () => {
  const toImp: Headers[] = [];
  const toApi: string[] = [];

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      toImp.push(request.headers);

      return new Response('imp');
    },
  });

  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      toApi.push(request.url);

      return new Response('api');
    },
  });

  await using ctx = await setupImpTest({
    env: {
      ...pickPorts(),
      IMP_API_PORT: String(api.port),
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
    },
  });

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  try {
    await ctx.createTestImage('ubuntu');

    const imp = await ctx.imps.createImp({ name: 'box', httpPort: upstream.port });

    await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
    await proxy.syncListeners();

    const port = ctx.config.portBase + imp.slot;
    const bodies: string[] = [];

    for (const host of ['box.tail1234.ts.net', 'imp.example.com', 'imp.tail1234.ts.net']) {
      const response = await fetch(`http://127.0.0.1:${String(port)}/rpc/system/info`, {
        method: 'POST',
        headers: {
          host,
          'x-forwarded-for': '100.101.1.2',
          'x-forwarded-proto': 'https',
          'tailscale-user-login': 'alice@example.com',
          cookie: 'a=1; imp_session=v1.2.secret',
          [PEER_HEADER]: 'forged',
        },
      });

      const body = await response.text();

      bodies.push(body);
    }

    const [first] = toImp;

    expect(bodies).toEqual(['imp', 'imp', 'imp']);
    expect(toApi).toEqual([]);

    expect(toImp.map((headers) => headers.get('host'))).toEqual([
      'box.tail1234.ts.net',
      'imp.example.com',
      'imp.tail1234.ts.net',
    ]);

    expect(first?.get('x-forwarded-host')).toBe('box.tail1234.ts.net');

    expect(first?.get('x-forwarded-for')).toMatch(
      /^100\.101\.1\.2, (?<v4mapped>::ffff:)?127\.0\.0\.1$/v,
    );

    expect(first?.get('tailscale-user-login')).toBe('alice@example.com');
    expect(first?.get('cookie')).toBe('a=1');
  } finally {
    await proxy.stop();
    await upstream.stop(true);
    await api.stop(true);
  }
});
