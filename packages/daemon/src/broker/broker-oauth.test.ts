import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupImpTest } from '../imps/test-imps';
import { loadOrCreateBrokerCa } from './broker-ca';

// An oauth secret through the broker on loopback, as in broker.test.ts. A
// fake API host and a fake token endpoint answer through the test-upstreams
// file over TLS the broker verifies, and every token is made up.

async function setupTest() {
  const fixtures = mkdtempSync(join(tmpdir(), 'imp-oauth-'));
  const upstreams = join(fixtures, 'upstreams.json');
  const apiSeen: { readonly path: string; readonly authorization: string | null }[] = [];
  const tokenSeen: string[] = [];
  const live = { refresh: 'fake-refresh-0', generation: 0 };
  const mode = { tokenAnswer: 'ok' as 'ok' | 'dead' };

  const ctx = await setupImpTest({
    env: { IMP_SUBNET: '127.0.0.0/16', IMP_BROKER_TEST_UPSTREAMS: upstreams },
  });

  await ctx.createTestImage('base');
  await ctx.imps.createImp({ name: 'dev' });

  const upstreamCa = await loadOrCreateBrokerCa(join(ctx.dataDir, 'upstream-ca'));
  const leaf = await upstreamCa.issueLeaf('localhost');

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: leaf.certPem, key: leaf.keyPem },
    fetch: async (request) => {
      const url = new URL(request.url);

      if (url.pathname === '/oauth/token') {
        const text = await request.text();

        const body = new URLSearchParams(text);

        tokenSeen.push(body.get('refresh_token') ?? '');

        // only the latest refresh token works, as a rotating endpoint does
        if (mode.tokenAnswer === 'dead' || body.get('refresh_token') !== live.refresh) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }

        live.generation += 1;
        live.refresh = `fake-refresh-${String(live.generation)}`;

        return Response.json({
          access_token: `fake-access-${String(live.generation)}`,
          refresh_token: live.refresh,
          expires_in: 3600,
        });
      }

      apiSeen.push({ path: url.pathname, authorization: request.headers.get('authorization') });

      return new Response('from the api');
    },
  });

  const origin = `https://localhost:${String(server.port)}`;

  writeFileSync(
    upstreams,
    JSON.stringify({
      ca: upstreamCa.certPem,
      upstreams: { 'api.example.com': origin, 'auth.example.com': origin },
    }),
  );

  const port = await ctx.broker.listen(0);

  const caFile = join(ctx.dataDir, 'broker', 'ca', 'ca.pem');

  const runCurl = async (url: string, extra: readonly string[] = []) => {
    const child = Bun.spawn(
      [
        'curl',
        '-sS',
        '--max-time',
        '10',
        '--interface',
        '127.0.0.2',
        '--proxy',
        `http://127.0.0.1:${String(port)}`,
        '--cacert',
        caFile,
        ...extra,
        url,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    return { stdout, code };
  };

  return {
    ...ctx,
    apiSeen,
    tokenSeen,
    mode,
    runCurl,
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);
      await ctx[Symbol.asyncDispose]();

      rmSync(fixtures, { recursive: true, force: true });
    },
  };
}

const CONFIG = {
  tokenUrl: 'https://auth.example.com/oauth/token',
  clientId: 'fake-client',
  tokenFormat: 'form' as const,
};

const RULES = [{ host: 'api.example.com', header: 'authorization', scheme: 'bearer' as const }];

test('the granted host gets the current access token, and a refresh changes it', async () => {
  await using ctx = await setupTest();

  const added = await ctx.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: RULES,
    oauth: CONFIG,
  });

  expect(added.oauth?.status).toBe('ready');

  await ctx.broker.addGrant('dev', 'codex');

  const first = await ctx.runCurl('https://api.example.com/v1', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(first).toEqual({ stdout: 'from the api', code: 0 });

  await ctx.broker.refreshSecret('codex');
  await ctx.runCurl('https://api.example.com/v2');

  expect(ctx.apiSeen).toEqual([
    { path: '/v1', authorization: 'Bearer fake-access-1' },
    { path: '/v2', authorization: 'Bearer fake-access-2' },
  ]);

  // each call used the refresh token the one before returned
  expect(ctx.tokenSeen).toEqual(['fake-refresh-0', 'fake-refresh-1']);
});

test('a secret with no access token gets no credential, and one that needs a new sign-in keeps its valid token', async () => {
  await using ctx = await setupTest();

  ctx.mode.tokenAnswer = 'dead';

  const dead = await ctx.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: RULES,
    oauth: CONFIG,
  });

  expect(dead.oauth?.status).toBe('needs_login');

  await ctx.broker.addGrant('dev', 'codex');

  // nothing to send: the broker's 403, and the fake API sees nothing
  const refused = await ctx.runCurl('https://api.example.com/v1', ['-w', '%{http_code}']);

  expect(refused.stdout).toContain('403');
  expect(ctx.apiSeen).toEqual([]);

  // a good sign-in, then the refresh token dies: the access token still works
  ctx.mode.tokenAnswer = 'ok';

  await ctx.broker.refreshSecret('codex');

  ctx.mode.tokenAnswer = 'dead';

  const after = await ctx.broker.refreshSecret('codex');

  expect(after.oauth?.status).toBe('needs_login');

  await ctx.runCurl('https://api.example.com/v2');

  expect(ctx.apiSeen).toEqual([{ path: '/v2', authorization: 'Bearer fake-access-1' }]);
});

test('a websocket upgrade is answered 426 and never reaches the upstream', async () => {
  await using ctx = await setupTest();

  await ctx.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: RULES,
    oauth: CONFIG,
  });

  await ctx.broker.addGrant('dev', 'codex');

  const result = await ctx.runCurl('https://api.example.com/socket', [
    '-H',
    'Connection: Upgrade',
    '-H',
    'Upgrade: websocket',
    '-w',
    '%{http_code}',
  ]);

  expect(result.stdout).toContain('websocket upgrades are not supported through the broker');
  expect(result.stdout.endsWith('426')).toBe(true);
  expect(ctx.apiSeen).toEqual([]);
});
