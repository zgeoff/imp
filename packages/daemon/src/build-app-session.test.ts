import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { TEST_TOKEN, buildTestApp, setupImpTest } from './imps/test-imps';

const ORIGIN = 'http://impd.test';

interface SendInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;

  // an empty multipart form as the body
  readonly form?: boolean;
}

async function setupTest() {
  const dashboardDir = mkdtempSync(join(tmpdir(), 'imp-dashboard-'));

  mkdirSync(join(dashboardDir, 'assets'));
  writeFileSync(join(dashboardDir, 'index.html'), '<!doctype html><title>imp</title>');

  const harness = await setupImpTest({ env: { IMP_DASHBOARD_DIR: dashboardDir } });

  const built = buildTestApp(harness, harness);

  const send = (path: string, init: SendInit = {}) =>
    built.app.handle(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        ...(init.form === true && { body: new FormData() }),
      }),
    );

  const sendLogin = async (token = TEST_TOKEN) => {
    const response = await send('/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? null;

    return { response, cookie };
  };

  return {
    ...harness,
    ...built,
    send,
    sendLogin,
    async [Symbol.asyncDispose]() {
      await harness[Symbol.asyncDispose]();

      rmSync(dashboardDir, { recursive: true, force: true });
    },
  };
}

interface RequestHandler {
  readonly handle: (request: Request) => Promise<Response>;
}

// an RPC client that sends what a browser on the dashboard's page sends
function buildBrowserClient(
  app: RequestHandler,
  headers: Readonly<Record<string, string>>,
): ContractRouterClient<ImpContract> {
  const link = new RPCLink({
    url: `${ORIGIN}/rpc`,
    headers,
    fetch: (request) => app.handle(request),
  });

  return createORPCClient(link);
}

test('a login trades the token for a session the API accepts from its own page', async () => {
  await using ctx = await setupTest();

  const login = await ctx.sendLogin();

  expect(login.response.status).toBe(204);
  expect(login.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
  expect(login.cookie).toStartWith('imp_session=v1.');

  const browser = buildBrowserClient(ctx.app, {
    cookie: login.cookie ?? '',
    'sec-fetch-site': 'same-origin',
  });

  const imps = await browser.imps.list();

  expect(imps).toEqual([]);
});

test('a login with the wrong token or from another origin sets nothing', async () => {
  await using ctx = await setupTest();

  const wrong = await ctx.sendLogin('wrong');

  expect(wrong.response.status).toBe(401);
  expect(wrong.cookie).toBeNull();

  const foreign = await ctx.send('/auth/login', {
    method: 'POST',
    headers: { origin: 'http://impd.test:20001', 'content-type': 'application/json' },
    body: JSON.stringify({ token: TEST_TOKEN }),
  });

  expect(foreign.status).toBe(403);
  expect(foreign.headers.get('set-cookie')).toBeNull();
});

test('the session alone never authorizes a request from another origin', async () => {
  await using ctx = await setupTest();

  const login = await ctx.sendLogin();

  const session = login.cookie ?? '';

  // what an imp's page on another port of this host can make a browser send:
  // a link, a form post and a text/plain fetch, none needing a preflight
  const attempts: readonly SendInit[] = [
    { method: 'GET', headers: { cookie: session } },
    { method: 'GET', headers: { cookie: session, 'sec-fetch-site': 'same-site' } },
    {
      method: 'POST',
      headers: { cookie: session, origin: 'http://impd.test:20001' },
      form: true,
    },
    { method: 'POST', headers: { cookie: session }, form: true },
    {
      method: 'POST',
      headers: { cookie: session, 'content-type': 'text/plain', origin: 'http://impd.test:20001' },
      body: '{"json":{}}',
    },
    {
      method: 'POST',
      headers: { cookie: session, 'content-type': 'text/plain' },
      body: '{"json":{}}',
    },
  ];

  for (const init of attempts) {
    const response = await ctx.send('/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', init);

    expect(response.status).toBe(401);
  }
});

test('the API refuses a GET even with the token', async () => {
  await using ctx = await setupTest();

  const response = await ctx.send('/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });

  expect(response.status).toBe(405);
});

test('a logout clears the cookie, only from its own origin', async () => {
  await using ctx = await setupTest();

  const foreign = await ctx.send('/auth/logout', {
    method: 'POST',
    headers: { origin: 'http://impd.test:20001' },
  });

  expect(foreign.status).toBe(403);

  const own = await ctx.send('/auth/logout', { method: 'POST', headers: { origin: ORIGIN } });

  expect(own.status).toBe(204);
  expect(own.headers.get('set-cookie')).toStartWith('imp_session=; Path=/; Max-Age=0');
});

test('/exec does not take the session cookie', async () => {
  await using ctx = await setupTest();

  const login = await ctx.sendLogin();

  const server = ctx.app.listen(0);

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${String(server.server?.port)}/exec`, {
      headers: {
        cookie: login.cookie ?? '',
        origin: `http://127.0.0.1:${String(server.server?.port)}`,
      },
    });

    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener('open', () => {
        resolve('open');
      });

      socket.addEventListener('error', () => {
        resolve('rejected');
      });
    });

    socket.close();

    expect(outcome).toBe('rejected');
  } finally {
    await server.stop(true);
  }
});

test('the dashboard shell answers app routes without shadowing the API', async () => {
  await using ctx = await setupTest();

  const root = await ctx.send('/');
  const shell = await ctx.send('/ui/imps/box');
  const health = await ctx.send('/health');
  const rpc = await ctx.send('/rpc/imps/list', { method: 'POST' });

  expect(root.headers.get('location')).toBe('/ui/');

  const shellBody = await shell.text();
  const healthBody: unknown = await health.json();

  expect(shellBody).toContain('<title>imp</title>');
  expect(healthBody).toEqual({ status: 'ok', ready: true });
  expect(rpc.status).toBe(401);
});
