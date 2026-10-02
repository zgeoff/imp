import { expect, test } from 'bun:test';
import type { Scope } from '@imp/api';
import * as z from 'zod';
import { createKnownHosts } from '../auth/ambient-request';
import { createTailnetIdentities } from '../auth/tailnet-identity';
import type { TailnetPeer } from '../auth/tailnet-identity';
import { listApiCalls } from '../db/api-audit';
import type { TailscaleStatus } from '../net/tailscale-status';
import { PEER_HEADER } from '../proxy/forwarded-peers';
import { setupImpdTest } from './test-mcp';

const TAILNET_PEER = '100.101.102.103';
const ALICE: TailnetPeer = { login: 'alice@example.com', tags: [], node: 'laptop' };
const MessageSchema = z.looseObject({ id: z.unknown().optional() });
const TextSchema = z.object({ type: z.string(), text: z.string() });

const ToolResultSchema = z.object({
  content: z.array(TextSchema),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean(),
});

const NamedSchema = z.object({ name: z.string() });
const ToolsSchema = z.object({ tools: z.array(NamedSchema) });
const CreatedSchema = z.object({ imp: NamedSchema });
const ResultSchema = z.object({ result: z.unknown() });

function readNoNode(): Promise<TailscaleStatus> {
  return Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] });
}

// alice's laptop may exec on dev-* imps
function buildTailnet(now: () => number) {
  return {
    identities: createTailnetIdentities({
      rules: [{ match: 'user:alice@example.com', scope: 'exec' as const, imps: ['dev-*'] }],
      whois: (address: string) => {
        const peer = address === TAILNET_PEER ? ALICE : null;

        return Promise.resolve(peer);
      },
      readTailscale: readNoNode,
      now,
    }),
    knownHosts: createKnownHosts({ readTailscale: readNoNode, domain: null }),
  };
}

// the messages of a response: one JSON body, or every event of an SSE stream
function parseMessages(contentType: string | null, text: string): unknown[] {
  const streamed = (contentType ?? '').includes('text/event-stream');

  if (!streamed) {
    return text === '' ? [] : [parseJson(text)];
  }

  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => parseJson(line.slice('data: '.length)));
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

// An MCP client over HTTP, as a remote agent runs one: `headers` say who it
// is, and every request after `initialize` carries its session's id.
function startHttpClient(url: string, headers: Readonly<Record<string, string>>) {
  const state: { session: string | null; nextId: number } = { session: null, nextId: 1 };

  const sendPost = (body: unknown, extra: Readonly<Record<string, string>> = {}) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(state.session !== null && { 'mcp-session-id': state.session }),
        ...headers,
        ...extra,
      },
      body: JSON.stringify(body),
    });

  const sendRequest = async (method: string, params: unknown = {}) => {
    const id = state.nextId++;

    const response = await sendPost({ jsonrpc: '2.0', id, method, params });
    const text = await response.text();

    const messages = parseMessages(response.headers.get('content-type'), text);

    const answer = messages
      .map((message) => MessageSchema.parse(message))
      .find((message) => message.id === id);

    return { status: response.status, answer };
  };

  return {
    sendPost,
    sendRequest,
    initialize: async () => {
      const response = await sendPost({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      });

      state.session = response.headers.get('mcp-session-id');

      return response;
    },
    listTools: async () => {
      const listed = await sendRequest('tools/list');

      return ToolsSchema.parse(ResultSchema.parse(listed.answer).result).tools.map(
        (tool) => tool.name,
      );
    },
    runTool: async (name: string, args: unknown = {}) => {
      const called = await sendRequest('tools/call', { name, arguments: args });

      return ToolResultSchema.parse(ResultSchema.parse(called.answer).result);
    },
  };
}

async function setupHttpTest(withTailnet = false) {
  const tailnet = withTailnet ? buildTailnet(Date.now) : null;

  const impd = await setupImpdTest({ tailnet });

  const createToken = async (name: string, scope: Scope, imps?: readonly string[]) => {
    const made = await impd.rootClient.tokens.create({
      name,
      scope,
      ...(imps !== undefined && { imps: [...imps] }),
    });

    return made.secret;
  };

  const openClient = async (secret: string) => {
    const client = startHttpClient(impd.url, { authorization: `Bearer ${secret}` });

    const opened = await client.initialize();

    expect(opened.status).toBe(200);

    return client;
  };

  return { ...impd, createToken, openClient };
}

test('a token limited to agent-* creates, names and runs commands in its own imps only', async () => {
  await using ctx = await setupHttpTest();

  const secret = await ctx.createToken('agent', 'manage', ['agent-*']);
  const agent = await ctx.openClient(secret);
  const created = await agent.runTool('imp_create', { image: 'ubuntu' });

  const name = CreatedSchema.parse(created.structuredContent).imp.name;

  expect(name).toMatch(/^agent-[a-z0-9]{8}$/);

  const executed = await agent.runTool('imp_exec', { name, command: 'echo hi' });

  expect(executed.structuredContent).toMatchObject({ exitCode: 0, stdout: 'hi\n' });

  const outside = await agent.runTool('imp_create', { name: 'other', image: 'ubuntu' });

  expect(outside.isError).toBe(true);
  expect(outside.content[0]?.text).toStartWith('FORBIDDEN: ');

  // the calls ran as the token, and the audit log says so
  const calls = await listApiCalls(ctx.db, name, 10, null);

  expect(calls.map((call) => [call.procedure, call.actorName, call.outcome])).toContainEqual([
    'imps.create',
    'agent',
    'ok',
  ]);
});

test('a read token sees only the read tools, and impd refuses the rest', async () => {
  await using ctx = await setupHttpTest();

  await ctx.rootClient.imps.create({ name: 'box', image: 'ubuntu' });

  const secret = await ctx.createToken('reader', 'read');
  const reader = await ctx.openClient(secret);
  const tools = await reader.listTools();

  expect(tools).toEqual(['imp_list', 'imp_url', 'imp_image_list', 'imp_checkpoint_list']);

  const listed = await reader.runTool('imp_list');

  expect(listed.structuredContent).toMatchObject({ imps: [{ name: 'box' }] });

  for (const [tool, args] of [
    ['imp_exec', { name: 'box', command: 'echo hi' }],
    ['imp_write_file', { name: 'box', path: '/x', content: 'x' }],
    ['imp_destroy', { name: 'box' }],
  ] as const) {
    const refused = await reader.runTool(tool, args);

    expect({ tool, text: refused.content[0]?.text.slice(0, 10) }).toEqual({
      tool,
      text: 'FORBIDDEN:',
    });
  }

  expect(ctx.guest.requests).toEqual([]);
});

test('a nameless create needs one prefix pattern, else a clear refusal', async () => {
  await using ctx = await setupHttpTest();

  const secret = await ctx.createToken('two', 'manage', ['a-*', 'b-*']);
  const two = await ctx.openClient(secret);
  const refused = await two.runTool('imp_create', { image: 'ubuntu' });

  expect(refused.isError).toBe(true);

  expect(refused.content[0]?.text).toBe(
    'GUARD: this token may touch only imps matching a-*, b-*, so give the new imp a name that matches',
  );
});

test('a session answers only the caller that opened it', async () => {
  await using ctx = await setupHttpTest();

  const firstSecret = await ctx.createToken('first', 'read');
  const first = await ctx.openClient(firstSecret);
  const secondSecret = await ctx.createToken('second', 'read');
  const opened = await first.initialize();

  const session = opened.headers.get('mcp-session-id') ?? '';
  const stranger = startHttpClient(ctx.url, { authorization: `Bearer ${secondSecret}` });

  const response = await stranger.sendPost(
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { 'mcp-session-id': session },
  );

  expect(response.status).toBe(404);
});

test('removing the token ends its session and the command it runs', async () => {
  await using ctx = await setupHttpTest();

  await ctx.rootClient.imps.create({ name: 'box', image: 'ubuntu' });

  const secret = await ctx.createToken('agent', 'exec');
  const agent = await ctx.openClient(secret);

  const call = agent.runTool('imp_exec', { name: 'box', command: 'sleepy' });

  while (ctx.guest.requests.length === 0) {
    await Bun.sleep(10);
  }

  await ctx.rootClient.tokens.delete({ name: 'agent' });

  const failure = await call.then(
    () => null,
    (error: unknown) => error,
  );

  // the stream closed with no answer
  expect(failure).toBeInstanceOf(Error);
  expect(ctx.guest.closed).toContain('sleepy');

  const after = await agent.sendPost({ jsonrpc: '2.0', id: 9, method: 'ping' });

  expect(after.status).toBe(401);
});

test('a tailnet identity needs no token, and its rule limits it', async () => {
  await using ctx = await setupHttpTest(true);

  await ctx.rootClient.imps.create({ name: 'dev-a', image: 'ubuntu' });
  await ctx.rootClient.imps.create({ name: 'prod', image: 'ubuntu' });

  // with no token and no address handed over, there is no caller
  const nobody = await startHttpClient(ctx.url, {}).initialize();

  expect(nobody.status).toBe(401);

  // each request comes through the wake proxy, which hands over alice's address
  const buildHandOver = () => ({ [PEER_HEADER]: ctx.peers.register(TAILNET_PEER) });
  const viaProxy = startHttpClient(ctx.url, {});

  const init = await viaProxy.sendPost(
    {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'atc' } },
    },
    buildHandOver(),
  );

  expect(init.status).toBe(200);

  const session = init.headers.get('mcp-session-id') ?? '';

  const call = await viaProxy.sendPost(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'imp_list', arguments: {} } },
    { ...buildHandOver(), 'mcp-session-id': session },
  );

  const text = await call.text();

  const [answer] = parseMessages(call.headers.get('content-type'), text);

  expect(answer).toMatchObject({ result: { structuredContent: { imps: [{ name: 'dev-a' }] } } });
});

test('a page on another origin is refused, Sec-Fetch-Site first, as the dashboard does', async () => {
  await using ctx = await setupHttpTest();

  const page = startHttpClient(ctx.url, { authorization: `Bearer ${ctx.token}` });
  const ping = { jsonrpc: '2.0', id: 0, method: 'ping' };

  const host = new URL(ctx.url).host;

  const statuses: number[] = [];

  for (const headers of [
    { origin: 'http://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site', origin: `http://${host}` },
    { 'sec-fetch-site': 'same-origin', origin: 'http://evil.example' },
    { origin: `https://${host}` },
  ]) {
    const response = await page.sendPost(ping, headers);

    statuses.push(response.status);
  }

  // a 400, not a 403: past the origin check, the ping has no session
  expect(statuses).toEqual([403, 403, 403, 400, 400]);
});
