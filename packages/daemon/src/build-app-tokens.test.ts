import { expect, test } from 'bun:test';
import type { ImpContract, Scope } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { PROCEDURE_ACCESS } from './auth/access-policy';
import { createKnownHosts } from './auth/ambient-request';
import { createTailnetIdentities } from './auth/tailnet-identity';
import type { TailnetPeer } from './auth/tailnet-identity';
import { listApiCalls } from './db/api-audit';
import { TEST_TOKEN, buildTestApp, setupImpTest } from './imps/test-imps';
import type { ImpTest } from './imps/test-imps';
import type { TailscaleStatus } from './net/tailscale-status';
import { PEER_HEADER } from './proxy/forwarded-peers';
import { tryExecSocket, tryTunnelSocket } from './test-sockets';

const SCOPES: readonly Scope[] = ['read', 'exec', 'manage'];
const TAILNET_PEER = '100.101.102.103';

interface TestApp {
  readonly handle: (request: Request) => Promise<Response>;
}

// alice's laptop is the one tailnet peer
function readFakeWhois(address: string): Promise<TailnetPeer | null> {
  const peer = address === TAILNET_PEER ? ALICE : null;

  return Promise.resolve(peer);
}

const ALICE: TailnetPeer = { login: 'alice@example.com', tags: [], node: 'laptop', stableId: null };

function readNoNode(): Promise<TailscaleStatus> {
  return Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] });
}

function buildBearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

interface TestOptions {
  // with a rule giving alice exec on dev-* imps
  readonly tailnet?: boolean;
}

async function setupTest(options: TestOptions = {}) {
  const harness = await setupImpTest();

  const tailnet =
    options.tailnet === true
      ? {
          identities: createTailnetIdentities({
            rules: [{ match: 'user:alice@example.com', scope: 'exec' as const, imps: ['dev-*'] }],
            whois: readFakeWhois,
            readTailscale: readNoNode,
            now: harness.now,
          }),
          knownHosts: createKnownHosts({
            readTailscale: readNoNode,
            domain: null,
          }),
        }
      : null;

  const root = buildTestApp(harness, harness, TEST_TOKEN, {}, tailnet);

  // a client for a token made with this scope and these imps
  const createTokenClient = async (
    name: string,
    scope: Scope,
    imps: readonly string[] | null = null,
  ) => {
    const made = await root.client.tokens.create({
      name,
      scope,
      ...(imps !== null && { imps: [...imps] }),
    });

    return { secret: made.secret, client: buildClient(root.app, made.secret) };
  };

  await harness.createTestImage('ubuntu');

  return { ...harness, ...root, createTokenClient };
}

function buildClient(app: TestApp, secret: string) {
  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: `Bearer ${secret}` },
    fetch: (request) => app.handle(request),
  });

  return createORPCClient<ContractRouterClient<ImpContract>>(link);
}

// calls a procedure by its path with an empty input: the access check runs
// before input validation, so a refusal is FORBIDDEN, not BAD_REQUEST
function runByPath(client: object, path: string): Promise<unknown> {
  const procedure: unknown = path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        typeof node === 'object' || typeof node === 'function'
          ? Reflect.get(node ?? {}, key)
          : undefined,
      client,
    );

  if (typeof procedure !== 'function') {
    throw new TypeError(`no client procedure at ${path}`);
  }

  return Promise.resolve(Reflect.apply(procedure, undefined, [{}]));
}

async function readErrorCode(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;

    return null;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'thrown';
  }
}

test('every procedure refuses a token whose scope is below what it needs', async () => {
  await using ctx = await setupTest();

  const clients = new Map<Scope, ContractRouterClient<ImpContract>>();

  for (const scope of SCOPES) {
    const connected = await ctx.createTokenClient(`scope-${scope}`, scope);

    clients.set(scope, connected.client);
  }

  const refusals: string[] = [];

  for (const [path, access] of Object.entries(PROCEDURE_ACCESS)) {
    const needed = SCOPES.indexOf(access.scope);

    for (const scope of SCOPES.slice(0, needed)) {
      const code = await readErrorCode(runByPath(clients.get(scope) ?? {}, path));

      refusals.push(`${path} ${scope} ${String(code)}`);
    }
  }

  expect(refusals.length).toBeGreaterThan(30);
  expect(refusals.filter((line) => !line.endsWith('FORBIDDEN'))).toEqual([]);
});

test('every host-wide procedure refuses a manage token limited to some imps', async () => {
  await using ctx = await setupTest();

  const limited = await ctx.createTokenClient('limited', 'manage', ['dev-*']);

  const hostPaths = Object.entries(PROCEDURE_ACCESS)
    .filter(([, access]) => access.on === 'host')
    .map(([path]) => path);

  const codes = await Promise.all(
    hostPaths.map((path) => readErrorCode(runByPath(limited.client, path))),
  );

  expect(hostPaths).toContain('grants.add');
  expect(codes).toEqual(hostPaths.map(() => 'FORBIDDEN'));
});

test('the root token makes, lists and removes tokens; the secret shows once', async () => {
  await using ctx = await setupTest();

  const made = await ctx.client.tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  expect(made.secret).toMatch(/^imp_[\w-]{16}\.[\w-]{43}$/);
  expect(made.token).toMatchObject({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  const listed = await ctx.client.tokens.list();

  expect(listed).toEqual([made.token]);
  expect(JSON.stringify(listed)).not.toContain(made.secret.split('.')[1] ?? 'none');

  const ci = buildClient(ctx.app, made.secret);

  const identity = await ci.tokens.whoami();

  expect(identity).toEqual({
    kind: 'token',
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
  });

  const conflicts = await Promise.all([
    readErrorCode(ctx.client.tokens.create({ name: 'ci', scope: 'read' })),
    readErrorCode(ctx.client.tokens.create({ name: 'root', scope: 'read' })),
  ]);

  expect(conflicts).toEqual(['CONFLICT', 'CONFLICT']);

  await ctx.client.tokens.delete({ name: 'ci' });

  const removed = await readErrorCode(ci.system.info());
  const left = await ctx.client.tokens.list();

  expect(removed).toBe('UNAUTHORIZED');
  expect(left).toEqual([]);
});

test('a token limited to dev-* sees and touches only its imps', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'prod', secret: 'gh' });

  const dev = await ctx.createTokenClient('dev', 'manage', ['dev-*']);
  const imps = await dev.client.imps.list();
  const secrets = await dev.client.secrets.list();

  expect(imps.map((imp) => imp.name)).toEqual(['dev-a']);
  expect(secrets.map((secret) => secret.imps)).toEqual([['dev-a']]);

  // another imp, a create that leaves the name to impd, a grant of a host
  // secret, and another imp's audit rows
  const refusals = await Promise.all([
    readErrorCode(dev.client.imps.stop({ name: 'prod' })),
    readErrorCode(dev.client.imps.create({})),
    readErrorCode(dev.client.imps.create({ name: 'prod-2' })),
    readErrorCode(dev.client.grants.add({ name: 'dev-a', secret: 'gh' })),
    readErrorCode(dev.client.audit.list({ name: 'prod' })),
    readErrorCode(dev.client.audit.calls({ name: 'prod' })),
  ]);

  expect(new Set(refusals)).toEqual(new Set(['FORBIDDEN']));

  await dev.client.imps.stop({ name: 'dev-a' });

  const calls = await waitForCalls(ctx, 6);
  const seen = await dev.client.audit.calls({});

  expect(calls.some((call) => call.imp === undefined)).toBeTrue();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((call) => call.imp?.startsWith('dev-') === true)).toBeTrue();

  const stop = seen.find((call) => call.procedure === 'imps.stop' && call.outcome === 'ok');

  expect(stop).toMatchObject({ actor: 'token', actorName: 'dev', imp: 'dev-a' });
});

test('a token limited to dev-* cannot copy another imp through its template', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.imps.create({ name: 'dev-src' });
  await ctx.client.images.add({ imp: 'prod', name: 'prod-tpl' });
  await ctx.client.images.add({ imp: 'dev-src', name: 'dev-tpl' });

  const dev = await ctx.createTokenClient('dev', 'manage', ['dev-*']);

  const refused = await readErrorCode(
    dev.client.imps.create({ name: 'dev-copy', image: 'prod-tpl' }),
  );

  expect(refused).toBe('FORBIDDEN');

  const allowed = await dev.client.imps.create({ name: 'dev-copy', image: 'dev-tpl' });

  expect(allowed.image).toBe('dev-tpl');

  // the root token's images.add rows name the imp whose disk each copied
  const calls = await waitForCalls(ctx, 6);

  const adds = calls
    .filter((call) => call.procedure === 'images.add')
    .map((call) => call.imp ?? '')
    .toSorted((a, b) => a.localeCompare(b));

  expect(adds).toEqual(['dev-src', 'prod']);
});

test('a limited token’s event stream holds only its imps', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const dev = await ctx.createTokenClient('dev', 'read', ['dev-*']);

  const controller = new AbortController();

  const stream = await dev.client.events.stream(undefined, { signal: controller.signal });

  const seen: string[] = [];

  await ctx.client.imps.stop({ name: 'prod' });
  await ctx.client.imps.stop({ name: 'dev-a' });

  for await (const event of stream) {
    seen.push(`${event.ev} ${'imp' in event ? event.imp.name : event.name}`);

    if (event.ev === 'ImpChanged' && event.imp.name === 'dev-a') {
      break;
    }
  }

  controller.abort();

  expect(seen[0]).toBe('ImpAdded dev-a');
  expect(seen.filter((line) => line.endsWith('prod'))).toEqual([]);
});

test('a read token cannot exec, and an exec token for dev-* cannot reach another imp', async () => {
  await using ctx = await setupTest();

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    await ctx.client.imps.create({ name: 'dev-a' });
    await ctx.client.imps.create({ name: 'prod' });

    const reader = await ctx.createTokenClient('reader', 'read');
    const dev = await ctx.createTokenClient('dev', 'exec', ['dev-*']);
    const readExec = await tryExecSocket(port, '', 'dev-a', buildBearer(reader.secret));
    const otherExec = await tryExecSocket(port, '', 'prod', buildBearer(dev.secret));
    const otherTunnel = await tryTunnelSocket(port, '', buildBearer(dev.secret), 'prod');

    expect(JSON.parse(readExec)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    expect(JSON.parse(otherExec)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    expect(JSON.parse(otherTunnel)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });

    const tickets = await Promise.all([
      readErrorCode(reader.client.exec.ticket({ name: 'dev-a' })),
      readErrorCode(dev.client.exec.ticket({ name: 'prod' })),
    ]);

    expect(tickets).toEqual(['FORBIDDEN', 'FORBIDDEN']);
  } finally {
    await server.stop(true);
  }
});

test('a ticket opens nothing once its token is removed', async () => {
  await using ctx = await setupTest();

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    await ctx.client.imps.create({ name: 'dev' });

    const ci = await ctx.createTokenClient('ci', 'exec');
    const issued = await ci.client.exec.ticket({ name: 'dev' });

    await ctx.client.tokens.delete({ name: 'ci' });

    const outcome = await tryExecSocket(port, `ticket=${issued.ticket}`);

    expect(outcome).toBe('rejected');
  } finally {
    await server.stop(true);
  }
});

test('removing a token closes its open sockets', async () => {
  await using ctx = await setupTest();

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    const ci = await ctx.createTokenClient('ci', 'exec');

    const socket = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
      headers: { authorization: `Bearer ${ci.secret}` },
    });

    const opened = Promise.withResolvers<undefined>();
    const closed = Promise.withResolvers<CloseEvent>();

    socket.addEventListener('open', () => {
      opened.resolve(undefined);
    });

    socket.addEventListener('close', closed.resolve);

    await opened.promise;

    await ctx.client.tokens.delete({ name: 'ci' });

    const event = await closed.promise;

    expect(event.code).toBe(1008);
  } finally {
    await server.stop(true);
  }
});

// A removal that lands after the token passed its check but before the
// socket opened: the socket must close all the same.
test('a socket that opens after its token is revoked closes at once', async () => {
  await using ctx = await setupTest();

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    const ci = await ctx.createTokenClient('ci', 'exec');

    const tokenId = /^imp_(?<id>[^.]+)\./v.exec(ci.secret)?.groups?.['id'] ?? '';

    expect(tokenId).not.toBe('');

    ctx.revocations.revoke(tokenId);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
      headers: { authorization: `Bearer ${ci.secret}` },
    });

    const closed = Promise.withResolvers<CloseEvent>();

    socket.addEventListener('close', closed.resolve);

    const event = await closed.promise;

    expect(event.code).toBe(1008);
  } finally {
    await server.stop(true);
  }
});

test('a token limited to no imps at all is refused', async () => {
  await using ctx = await setupTest();

  const made = ctx.client.tokens.create({ name: 'none', scope: 'read', imps: [] });

  const code = await readErrorCode(made);

  expect(code).toBe('BAD_REQUEST');
});

test('a tailnet identity reaches the API only through a peer handle impd made', async () => {
  await using ctx = await setupTest({ tailnet: true });

  const server = ctx.app.listen(0);

  try {
    const url = `http://127.0.0.1:${String(server.server?.port)}/rpc/tokens/whoami`;

    const sendWhoami = (headers: Readonly<Record<string, string>>) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } });

    // a client on loopback names a tailnet address itself
    const forged = await sendWhoami({
      [PEER_HEADER]: TAILNET_PEER,
      'x-forwarded-for': TAILNET_PEER,
    });

    // the wake proxy registered this client's address
    const handed = await sendWhoami({ [PEER_HEADER]: ctx.peers.register(TAILNET_PEER) });

    expect(forged.status).toBe(401);
    expect(handed.status).toBe(200);

    const body: unknown = await handed.json();

    expect(body).toMatchObject({ json: { kind: 'tailnet', name: 'alice@example.com' } });
  } finally {
    await server.stop(true);
  }
});

test('a tailnet identity opens no socket for a page on an imp’s port', async () => {
  await using ctx = await setupTest({ tailnet: true });

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    await ctx.client.imps.create({ name: 'dev-a' });

    const buildPeerHeaders = (origin: string) => ({
      [PEER_HEADER]: ctx.peers.register(TAILNET_PEER),
      origin,
    });

    const fromImp = await tryExecSocket(
      port,
      '',
      'dev-a',
      buildPeerHeaders('http://127.0.0.1:20000'),
    );

    const fromImpTunnel = await tryTunnelSocket(
      port,
      '',
      buildPeerHeaders('http://127.0.0.1:20000'),
      'dev-a',
    );

    const fromDashboard = await tryExecSocket(
      port,
      '',
      'dev-a',
      buildPeerHeaders(`http://127.0.0.1:${port}`),
    );

    expect(fromImp).toBe('rejected');
    expect(fromImpTunnel).toBe('rejected');

    // past the auth: the fake VM has no agent to start the exec
    expect(fromDashboard).not.toBe('rejected');
  } finally {
    await server.stop(true);
  }
});

// the audit log once it holds `count` rows; each lands after its answer
async function waitForCalls(ctx: Readonly<Pick<ImpTest, 'db'>>, count: number) {
  const deadline = Date.now() + 5000;

  for (;;) {
    const calls = await listApiCalls(ctx.db, null, 100, null);

    if (calls.length >= count || Date.now() > deadline) {
      return calls;
    }

    await Bun.sleep(5);
  }
}
