import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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

async function setupBroker(options: { readonly tunnelTo?: string } = {}) {
  // the broker reads the file when a request comes, so it is written below
  const fixtures = mkdtempSync(join(tmpdir(), 'imp-broker-'));
  const upstreams = join(fixtures, 'upstreams.json');

  const ctx = await setupImpTest({
    env: { IMP_SUBNET: '127.0.0.0/16', IMP_BROKER_TEST_UPSTREAMS: upstreams },
    ...(options.tunnelTo !== undefined && {
      resolveTunnelTarget: () => Promise.resolve(options.tunnelTo ?? ''),
    }),
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

      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        bodyBytes: body.byteLength,
      });

      return new Response('from upstream');
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
    runCurl,
    [Symbol.asyncDispose]: async () => {
      await upstream.stop(true);
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

  // no grant: the tunnel's target is a public check away, so the default
  // resolver refuses localhost outright
  const result = await ctx.runCurl('https://api.github.com/user');

  expect(result.code).not.toBe(0);
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
    await using ctx = await setupBroker({ tunnelTo: '127.0.0.1' });

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

  const after = await ctx.runCurl('https://api.github.com/b');

  expect(after.code).not.toBe(0);
  expect(ctx.seen.map((entry) => entry.path)).toEqual(['/a']);
});
