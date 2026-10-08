import { expect, onTestFinished, test } from 'bun:test';
import { removeImp, updateImpMove } from '../db/imps';
import { createImpTest, setupImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';
import { findFreePorts } from '../test-utils/find-free-ports';
import { PEER_HEADER, createForwardedPeers } from './forwarded-peers';
import { startWakeProxy } from './wake-proxy';

// the slots of 10.99.0.0/24
const SLOT_COUNT = 64;

// free ports for the proxy and slot 0, the slot each test's imp takes; impd
// refuses a proxy port among the imp ports, so a pick there is made again
function pickPorts(): Readonly<Record<'IMP_PROXY_PORT' | 'IMP_PORT_BASE' | 'IMP_SUBNET', string>> {
  const ports = findFreePorts(2);
  const proxy = ports.take();
  const base = ports.take();

  if (proxy >= base && proxy < base + SLOT_COUNT) {
    return pickPorts();
  }

  return {
    IMP_PROXY_PORT: String(proxy),
    IMP_PORT_BASE: String(base),
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

  const ctx = await setupImpTest({ env: ports });

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
// and WebSocket upgrade, with an imp whose address points at it. `respond`
// answers a plain request; `ok` by default.
async function setupUpstreamTest(
  respond: (request: Request) => Response | Promise<Response> = () => new Response('ok'),
) {
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

      return respond(request);
    },
    websocket: {
      message: (ws, message) => {
        ws.send(message);
      },
    },
  });

  onTestFinished(() => upstream.stop(true));

  const ports = pickPorts();

  // the proxy stops before the harness closes its database
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await createImpTest(stack, { env: ports });

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  stack.defer(() => proxy.stop());

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  return {
    cookies,
    port: Number(ports.IMP_PORT_BASE) + imp.slot,
  };
}

test('the proxy keeps the dashboard session cookie from an imp over HTTP', async () => {
  const ctx = await setupUpstreamTest();

  const response = await fetch(`http://127.0.0.1:${String(ctx.port)}/`, {
    headers: { cookie: 'a=1; imp_session=v1.2.secret; __Host-imp_session=v1.2.secret; b=2' },
  });

  await response.text();

  expect(ctx.cookies).toEqual(['a=1; b=2']);
});

test('the proxy keeps the dashboard session cookie from an imp over a WebSocket', async () => {
  const ctx = await setupUpstreamTest();

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

  const ctx = await setupImpTest({
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

// A streamed build (docs/guides/images.md#build-an-image) lives on its
// progress lines: the proxy in front of the API must pass each one on as it
// comes, not hold the body until it ends.
test('the API route passes a streamed answer on line by line', async () => {
  const second = Promise.withResolvers<void>();

  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      const body = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          controller.enqueue(new TextEncoder().encode('first\n'));

          await second.promise;

          controller.enqueue(new TextEncoder().encode('second\n'));
          controller.close();
        },
      });

      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
    },
  });

  const ctx = await setupImpTest({
    env: { ...pickPorts(), IMP_API_PORT: String(api.port) },
  });

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  try {
    const response = await fetch(`http://127.0.0.1:${String(apex.port)}/images/build`, {
      method: 'POST',
      body: 'tar',
    });

    const lines = response.body?.pipeThrough(new TextDecoderStream()).getReader();

    // the first line arrives while the API still holds the second
    const first = await lines?.read();

    expect(first?.value).toBe('first\n');

    second.resolve();

    const parts: string[] = [];

    for (let chunk = await lines?.read(); chunk?.done === false; chunk = await lines?.read()) {
      parts.push(chunk.value);
    }

    expect(parts.join('')).toBe('second\n');
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

  const ctx = await setupImpTest({
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

test('a client that goes away stops the request to the imp', async () => {
  const reached = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();

  // answers only once the request is aborted
  const ctx = await setupUpstreamTest(async (request) => {
    request.signal.addEventListener('abort', () => {
      aborted.resolve();
    });

    reached.resolve();

    await aborted.promise;

    return new Response('late');
  });

  const client = new AbortController();

  const pending = readRejection(
    fetch(`http://127.0.0.1:${String(ctx.port)}/slow`, { signal: client.signal }),
  );

  await reached.promise;

  client.abort();

  const outcome = await Promise.race([
    aborted.promise.then(() => 'upstream aborted'),
    Bun.sleep(5000).then(() => 'upstream kept waiting'),
  ]);

  await pending;

  expect(outcome).toBe('upstream aborted');
});

test('a slot that could not listen warns again once a new imp holds it', async () => {
  const ports = pickPorts();
  const logs: string[] = [];

  const ctx = await setupImpTest({ env: ports });

  // something else holds the imp port of slot 0
  const squatter = Bun.serve({
    port: Number(ports.IMP_PORT_BASE),
    hostname: '0.0.0.0',
    fetch: () => new Response('squatter'),
  });

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: (message) => {
      logs.push(message);
    },
    peers: createForwardedPeers(Date.now),
  });

  try {
    await ctx.createTestImage('ubuntu');

    const first = await ctx.imps.createImp({ name: 'first' });

    await proxy.syncListeners();
    await proxy.syncListeners();

    await removeImp(ctx.db, first.id);

    await proxy.syncListeners();

    const second = await ctx.imps.createImp({ name: 'second' });

    await proxy.syncListeners();

    const warnings = logs.filter((line) => line.includes('cannot listen'));

    expect(second.slot).toBe(first.slot);
    expect(warnings).toHaveLength(2);
  } finally {
    await proxy.stop();
    await squatter.stop(true);
  }
});

test('a request to a moving imp gets 503 with Retry-After', async () => {
  const ports = pickPorts();

  const ctx = await setupImpTest({ env: ports });

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  try {
    await ctx.createTestImage('ubuntu');

    const imp = await ctx.imps.createImp({ name: 'web' });

    await ctx.imps.stopImp('web');

    await updateImpMove(ctx.db, imp.id, 'sending');

    await proxy.syncListeners();

    const response = await fetch(
      `http://127.0.0.1:${String(Number(ports.IMP_PORT_BASE) + imp.slot)}/`,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
  } finally {
    await proxy.stop();
  }
});
