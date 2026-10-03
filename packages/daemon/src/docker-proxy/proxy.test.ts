import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROXY_LABEL, createDockerProxy } from './proxy';

const TOKEN = 'test-token';
const OWN_ID = 'a'.repeat(64);
const OTHER_ID = 'b'.repeat(64);
const CONTEXT_MAX_BYTES = 4 * 1024 ** 2;

interface Seen {
  readonly method: string;
  readonly target: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const dir = mkdtempSync(join(tmpdir(), 'imp-docker-proxy-'));
const engineSocket = join(dir, 'engine.sock');
const proxySocket = join(dir, 'proxy.sock');
const seen: Seen[] = [];
const logged: string[] = [];

function readContainer(id: string): Response {
  const labels = id === OWN_ID ? { [PROXY_LABEL]: TOKEN } : { [PROXY_LABEL]: '1' };

  return Response.json({ Id: id, Config: { Labels: labels } });
}

// a fake engine: records each request, answers the ones the proxy sends
const engine = Bun.serve({
  unix: engineSocket,
  fetch: async (request) => {
    const url = new URL(request.url);

    const body = await request.text();

    seen.push({
      method: request.method,
      target: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      body,
    });

    const inspect = /\/containers\/(?<id>[^\/]+)\/json$/v.exec(url.pathname)?.groups?.['id'];

    if (inspect !== undefined) {
      const id = inspect.startsWith('a') ? OWN_ID : OTHER_ID;

      return inspect.startsWith('a') || inspect.startsWith('b')
        ? readContainer(id)
        : new Response('no such container', { status: 404 });
    }

    if (url.pathname.endsWith('/_ping')) {
      return new Response('OK', { headers: { 'api-version': '1.55' } });
    }

    if (url.pathname.endsWith('/export')) {
      return new Response('tar bytes');
    }

    return Response.json({ received: body.length });
  },
});

const proxy = Bun.serve({
  unix: proxySocket,
  maxRequestBodySize: CONTEXT_MAX_BYTES * 2,
  fetch: createDockerProxy({
    upstreamSocket: engineSocket,
    token: TOKEN,
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    buildContextMaxBytes: CONTEXT_MAX_BYTES,
    log: (message) => {
      logged.push(message);
    },
  }),
});

interface ProxyInit {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | ReadableStream<Uint8Array>;
}

function sendToProxy(method: string, target: string, init: ProxyInit = {}): Promise<Response> {
  return fetch(`http://docker${target}`, { ...init, method, unix: proxySocket });
}

beforeAll(() => {
  expect(engine.url).toBeDefined();
});

beforeEach(() => {
  seen.length = 0;
  logged.length = 0;
});

afterAll(async () => {
  await proxy.stop(true);
  await engine.stop(true);

  rmSync(dir, { recursive: true, force: true });
});

test('a ping reaches the engine and its API version comes back', async () => {
  const response = await sendToProxy('HEAD', '/_ping');

  expect(response.status).toBe(200);
  expect(response.headers.get('api-version')).toBe('1.55');
  expect(seen.map((request) => `${request.method} ${request.target}`)).toEqual(['HEAD /_ping']);
});

test('a create sends the proxy’s own body, with its label and no network', async () => {
  const response = await sendToProxy('POST', '/v1.55/containers/create', {
    headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    body: JSON.stringify({
      Image: 'busybox',
      Cmd: ['/bin/true'],
      AttachStdout: true,
      HostConfig: { NetworkMode: 'default' },
    }),
  });

  expect(response.status).toBe(200);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.target).toBe('/v1.55/containers/create');
  expect(seen[0]?.headers['authorization']).toBeUndefined();

  expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
    Image: 'busybox',
    Cmd: ['/bin/true'],
    Labels: { [PROXY_LABEL]: TOKEN },
    HostConfig: { NetworkMode: 'none', RestartPolicy: { Name: 'no' } },
  });
});

test('a create with a bind, or a body over 1 MiB sent chunked, never reaches the engine', async () => {
  const bound = await sendToProxy('POST', '/v1.55/containers/create', {
    body: JSON.stringify({
      Image: 'busybox',
      Cmd: ['/bin/true'],
      HostConfig: { Binds: ['/:/host'] },
    }),
  });

  const chunk = new Uint8Array(64 * 1024).fill(32);

  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 20; index += 1) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

  const large = await sendToProxy('POST', '/v1.55/containers/create', { body: chunked });

  expect(bound.status).toBe(403);

  const refusal: unknown = await bound.json();

  expect(refusal).toEqual({ message: 'imp-docker-proxy: HostConfig.Binds is set' });
  expect(large.status).toBe(403);
  expect(seen).toEqual([]);
  expect(logged).toHaveLength(2);
});

test('an export or rm of a container the proxy created goes to its full ID', async () => {
  const exported = await sendToProxy('GET', '/v1.55/containers/aaaa/export');
  const removed = await sendToProxy('DELETE', '/v1.55/containers/aaaa?force=1');
  const tar = await exported.text();

  expect(tar).toBe('tar bytes');
  expect(removed.status).toBe(200);

  expect(seen.map((request) => `${request.method} ${request.target}`)).toEqual([
    'GET /v1.55/containers/aaaa/json',
    `GET /v1.55/containers/${OWN_ID}/export`,
    'GET /v1.55/containers/aaaa/json',
    `DELETE /v1.55/containers/${OWN_ID}?force=1&v=1`,
  ]);
});

test('an export or rm of another container, even one whose image sets the label, is refused', async () => {
  const exported = await sendToProxy('GET', '/v1.55/containers/bbbb/export');
  const removed = await sendToProxy('DELETE', '/v1.55/containers/bbbb?force=1');
  const missing = await sendToProxy('DELETE', '/v1.55/containers/cccc?force=1');

  expect([exported.status, removed.status, missing.status]).toEqual([403, 403, 403]);

  expect(
    seen.every((request) => request.method === 'GET' && request.target.endsWith('/json')),
  ).toBe(true);
});

test('a build streams its context and keeps only the registry headers', async () => {
  const context = new Uint8Array(2 * 1024 ** 2).fill(7);

  const response = await sendToProxy('POST', '/v1.55/build?t=imp%2Fx%3Alatest&q=1&version=1', {
    headers: { 'content-type': 'application/x-tar', 'x-registry-config': 'e30=', cookie: 'c=1' },
    body: context,
  });

  const answer: unknown = await response.json();

  expect(answer).toEqual({ received: context.length });
  expect(seen[0]?.target).toBe('/v1.55/build?t=imp%2Fx%3Alatest&q=1&version=1');
  expect(seen[0]?.headers['x-registry-config']).toBe('e30=');
  expect(seen[0]?.headers['cookie']).toBeUndefined();
});

test('a build context over the limit, sent chunked, is cut off', async () => {
  const chunk = new Uint8Array(1024 ** 2);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 6; index += 1) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

  const response = await sendToProxy('POST', '/v1.55/build?t=imp%2Fx%3Alatest&version=1', {
    body: stream,
  });

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(seen.every((request) => request.body.length <= CONTEXT_MAX_BYTES)).toBe(true);
});

test('a pull forwards fromImage and tag only, and a pull with a body is refused', async () => {
  const pulled = await sendToProxy('POST', '/v1.55/images/create?fromImage=busybox&tag=latest', {
    headers: { 'x-registry-auth': 'e30=' },
  });

  const withBody = await sendToProxy('POST', '/v1.55/images/create?fromImage=busybox&tag=latest', {
    body: 'x',
  });

  expect(pulled.status).toBe(200);
  expect(withBody.status).toBe(403);

  expect(seen.map((request) => request.target)).toEqual([
    '/v1.55/images/create?fromImage=busybox&tag=latest',
  ]);

  expect(seen[0]?.headers['x-registry-auth']).toBe('e30=');
});

test('an Upgrade, a refused route and a refused param never reach the engine', async () => {
  const upgrade = await sendToProxy('POST', '/v1.55/build?t=imp%2Fx%3Alatest&version=1', {
    headers: { upgrade: 'h2c', connection: 'Upgrade' },
  });

  const start = await sendToProxy('POST', `/v1.55/containers/${OWN_ID}/start`);

  const remote = await sendToProxy(
    'POST',
    '/v1.55/build?t=imp%2Fx%3Alatest&version=1&remote=https%3A%2F%2Fx',
  );

  expect([upgrade.status, start.status, remote.status]).toEqual([403, 403, 403]);

  const refusal: unknown = await start.json();

  expect(refusal).toEqual({
    message: `imp-docker-proxy: POST /containers/${OWN_ID}/start is not a call impd makes`,
  });

  expect(seen).toEqual([]);
});
