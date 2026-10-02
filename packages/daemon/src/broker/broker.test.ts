import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAuditEntries } from '../db/broker-audit';
import { findImpByName } from '../db/imps';
import { setupImpTest } from '../imps/test-imps';
import { loadOrCreateBrokerCa } from './broker-ca';
import type { Broker } from './broker-service';

// The broker end to end on loopback: with IMP_SUBNET 127.0.0.0/16, curl
// bound to 127.0.0.2 is slot 0's guest, and 127.0.0.1 its gateway. A fake
// upstream serves the granted host through the test-upstreams file.

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly bodyBytes: number;
}

async function setupBroker() {
  // the broker reads the file when a request comes, so it is written below
  const fixtures = mkdtempSync(join(tmpdir(), 'imp-broker-'));
  const upstreams = join(fixtures, 'upstreams.json');

  // the real host past a plain tunnel, with a CA nobody trusts
  const realCa = await loadOrCreateBrokerCa(join(fixtures, 'real-ca'));
  const realLeaf = await realCa.issueLeaf('api.github.com');

  const tunnelled: Seen[] = [];

  const realHost = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: realLeaf.certPem, key: realLeaf.keyPem },
    fetch: (request) => {
      tunnelled.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        bodyBytes: 0,
      });

      return new Response('from the real host');
    },
  });

  const realPort = realHost.port ?? 0;

  // plain tunnels stay on loopback, and port 443 goes to the real host
  const ctx = await setupImpTest({
    env: { IMP_SUBNET: '127.0.0.0/16', IMP_BROKER_TEST_UPSTREAMS: upstreams },
    resolveTunnelTarget: () => Promise.resolve('127.0.0.1'),
    dialTunnel: (address, port) =>
      createConnection({ host: address, port: port === 443 ? realPort : port }),
  });

  await ctx.createTestImage('base');
  await ctx.imps.createImp({ name: 'dev' });

  const seen: Seen[] = [];

  // the fake upstream, with its own CA the broker is told to trust
  const upstreamCa = await loadOrCreateBrokerCa(join(ctx.dataDir, 'upstream-ca'));
  const upstreamLeaf = await upstreamCa.issueLeaf('localhost');

  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: upstreamLeaf.certPem, key: upstreamLeaf.keyPem },
    maxRequestBodySize: 64 * 1024 ** 2,
    fetch: async (request) => {
      const body = await request.arrayBuffer();

      const path = new URL(request.url).pathname;

      seen.push({
        method: request.method,
        path,
        authorization: request.headers.get('authorization'),
        bodyBytes: body.byteLength,
      });

      const statuses: Readonly<Record<string, ResponseInit>> = {
        '/none': { status: 204 },
        '/same': { status: 304 },
        '/moved': { status: 302, headers: { location: 'https://objects.example.com/x' } },
      };

      const init = statuses[path];

      return init === undefined ? new Response('from upstream') : new Response(null, init);
    },
  });

  writeFileSync(
    upstreams,
    JSON.stringify({
      ca: upstreamCa.certPem,
      upstreams: { 'api.github.com': `https://localhost:${String(upstream.port)}` },
    }),
  );

  const port = await ctx.broker.listen(0);

  const caFile = join(ctx.dataDir, 'broker', 'ca', 'ca.pem');

  // curl as the guest: from 127.0.0.2 (or `from`) through the gateway
  const runCurl = async (
    url: string,
    extra: readonly string[] = [],
    from = '127.0.0.2',
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
    const child = Bun.spawn(
      [
        'curl',
        '-sS',
        '--max-time',
        '10',
        '--interface',
        from,
        '--proxy',
        `http://127.0.0.1:${String(port)}`,
        '--cacert',
        caFile,
        ...extra,
        url,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { code, stdout, stderr };
  };

  return {
    ...ctx,
    seen,
    tunnelled,
    runCurl,
    [Symbol.asyncDispose]: async () => {
      await upstream.stop(true);
      await realHost.stop(true);
      await ctx[Symbol.asyncDispose]();

      rmSync(fixtures, { recursive: true, force: true });
    },
  };
}

async function createGithubGrant(broker: Broker): Promise<void> {
  await broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_real' });
  await broker.addGrant('dev', 'gh');
}

test('a granted host gets the real credential in place of the placeholder', async () => {
  await using ctx = await setupBroker();

  await createGithubGrant(ctx.broker);

  const result = await ctx.runCurl('https://api.github.com/user?x=1', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toMatchObject({ code: 0, stdout: 'from upstream' });

  expect(ctx.seen).toEqual([
    { method: 'GET', path: '/user', authorization: 'Bearer ghp_real', bodyBytes: 0 },
  ]);

  const imp = await findImpByName(ctx.db, 'dev');
  const audit = await listAuditEntries(ctx.db, imp?.id ?? null, 10);

  expect(audit).toMatchObject([{ imp: 'dev', secret: 'gh', path: '/user', status: 200 }]);
});

test('a large upload streams through and is counted', async () => {
  await using ctx = await setupBroker();

  await createGithubGrant(ctx.broker);

  const body = join(ctx.dataDir, 'pack');
  const size = 3 * 1024 * 1024 + 17;

  writeFileSync(body, Buffer.alloc(size, 7));

  const result = await ctx.runCurl('https://api.github.com/upload', ['--data-binary', `@${body}`]);

  expect(result.code).toBe(0);
  expect(ctx.seen[0]?.bodyBytes).toBe(size);

  const audit = await listAuditEntries(ctx.db, null, 10);

  expect(audit[0]?.requestBytes).toBe(size);
});

test('without a grant the host is tunnelled, and the guest sees the real certificate', async () => {
  await using ctx = await setupBroker();

  const placeholder = ['-H', 'Authorization: Bearer imp-broker-placeholder'];

  // no grant: the guest reaches the real host, whose certificate the broker
  // CA did not sign (curl's 60), and no credential is added
  const untrusted = await ctx.runCurl('https://api.github.com/user', placeholder);

  expect(untrusted.code).toBe(60);

  const insecure = await ctx.runCurl('https://api.github.com/user', ['-k', ...placeholder]);

  expect(insecure).toMatchObject({ code: 0, stdout: 'from the real host' });

  expect(ctx.tunnelled).toEqual([
    { method: 'GET', path: '/user', authorization: 'Bearer imp-broker-placeholder', bodyBytes: 0 },
  ]);

  expect(ctx.seen).toHaveLength(0);
});

test('a plain tunnel dials the checked address, and a closed egress policy refuses it', async () => {
  const echo = createServer((socket) => {
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\ntunnel');
  });

  const listening = Promise.withResolvers<void>();

  echo.listen(0, '127.0.0.1', listening.resolve);

  await listening.promise;

  const address = echo.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    await using ctx = await setupBroker();

    const open = await ctx.runCurl(`http://plain.test:${String(port)}/`, ['--proxytunnel']);

    expect(open).toMatchObject({ code: 0, stdout: 'tunnel' });

    await ctx.db.updateTable('imps').set({ egress_policy: 'none' }).execute();

    const closed = await ctx.runCurl(`http://plain.test:${String(port)}/`, ['--proxytunnel']);

    expect(closed.code).not.toBe(0);
    expect(closed.stderr).toContain('403');
  } finally {
    echo.close();
  }
});

test('a guest on another imp’s gateway, or a request that is not CONNECT, gets nothing', async () => {
  await using ctx = await setupBroker();

  await createGithubGrant(ctx.broker);

  // 127.0.0.6 is slot 1's guest, dialling slot 0's gateway
  const other = await ctx.runCurl('https://api.github.com/user', [], '127.0.0.6');

  expect(other.code).not.toBe(0);

  // a plain proxy GET, not a tunnel
  const get = await ctx.runCurl('http://api.github.com/user');

  expect(get.stdout).toContain('only CONNECT');
  expect(ctx.seen).toHaveLength(0);
});

test('a revoke stops the credential at once', async () => {
  await using ctx = await setupBroker();

  await createGithubGrant(ctx.broker);

  const before = await ctx.runCurl('https://api.github.com/a');

  expect(before.code).toBe(0);

  await ctx.broker.removeGrant('dev', 'gh');

  // now a plain tunnel: the real host's certificate, which the guest does
  // not trust
  const after = await ctx.runCurl('https://api.github.com/b');

  expect(after.code).toBe(60);
  expect(ctx.seen.map((entry) => entry.path)).toEqual(['/a']);
  expect(ctx.tunnelled).toHaveLength(0);
});

test('bodiless answers and redirects pass through as they are', async () => {
  await using ctx = await setupBroker();

  await createGithubGrant(ctx.broker);

  for (const [path, code] of [
    ['/none', '204'],
    ['/same', '304'],
    ['/moved', '302'],
  ] as const) {
    const result = await ctx.runCurl(`https://api.github.com${path}`, [
      '-o',
      '/dev/null',
      '-w',
      '%{http_code} %{redirect_url}',
    ]);

    const location = path === '/moved' ? 'https://objects.example.com/x' : '';

    expect({ path, stdout: result.stdout.trim() }).toEqual({
      path,
      stdout: `${code} ${location}`.trim(),
    });
  }
});
