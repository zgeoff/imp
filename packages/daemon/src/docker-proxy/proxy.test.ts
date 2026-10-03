import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCKERFILE_FRONTEND } from './dockerfile-frontend';
import { loadOwnedImages } from './owned-images';
import { PROXY_LABEL, createDockerProxy } from './proxy';

const TOKEN = 'test-token';
const OWN_ID = 'a'.repeat(64);
const OTHER_ID = 'b'.repeat(64);
const CONTEXT_MAX_BYTES = 4 * 1024 ** 2;

// a build as impd sends it
const BUILD_PATH = `/v1.55/build?${new URLSearchParams({
  t: 'imp/x:latest',
  version: '2',
  buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
}).toString()}`;

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
const ownedPath = join(dir, 'owned-images.json');
const ownedImages = loadOwnedImages(ownedPath);
const logged: string[] = [];
const HOST_IMAGE = 'ghcr.io/zgeoff/imp-host:latest';

// the engine's images: each ID and its tags
const engineImages = new Map<string, string[]>();

// references the engine refuses to remove, as when a container uses them
const inUse = new Set<string>();

function findEngineImageId(name: string): string | undefined {
  for (const [id, tags] of engineImages) {
    if (id === name || tags.includes(name)) {
      return id;
    }
  }

  return undefined;
}

// moves `tag` to `id`, as a pull or a build does
function writeEngineTag(tag: string, id: string): void {
  for (const tags of engineImages.values()) {
    tags.splice(0, tags.length, ...tags.filter((one) => one !== tag));
  }

  engineImages.set(id, [...(engineImages.get(id) ?? []), tag]);
}

function buildImageId(fill: string): string {
  return `sha256:${fill.repeat(64)}`;
}

// a slow build on the engine: it started, and its client went
const slowBuild = { started: Promise.withResolvers<void>(), gone: Promise.withResolvers<void>() };

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

    const inspected = /\/images\/(?<name>.+)\/json$/v.exec(url.pathname)?.groups?.['name'];

    if (request.method === 'GET' && inspected !== undefined) {
      const id = findEngineImageId(inspected);

      return id === undefined
        ? new Response('no such image', { status: 404 })
        : Response.json({ Id: id, RepoTags: engineImages.get(id), RepoDigests: [] });
    }

    const removed = /\/images\/(?<name>.+)$/v.exec(url.pathname)?.groups?.['name'];

    if (request.method === 'DELETE' && removed !== undefined) {
      const id = findEngineImageId(removed);

      if (id === undefined) {
        return new Response('no such image', { status: 404 });
      }

      if (inUse.has(removed)) {
        return Response.json({ message: 'image is being used by a container' }, { status: 409 });
      }

      const tags = (engineImages.get(id) ?? []).filter((tag) => tag !== removed);

      if (tags.length === 0 || removed === id) {
        engineImages.delete(id);
      } else {
        engineImages.set(id, tags);
      }

      return Response.json([{ Untagged: removed }]);
    }

    if (url.pathname.endsWith('/images/create')) {
      const fromImage = url.searchParams.get('fromImage') ?? '';
      const tag = url.searchParams.get('tag') ?? '';

      writeEngineTag(`${fromImage}:${tag}`, buildImageId('c'));
    }

    const built = url.searchParams.get('t');

    if (url.pathname.endsWith('/build') && built !== null && built !== 'imp/slow:latest') {
      const fill = built === 'imp/x:latest' ? 'd' : 'e';

      writeEngineTag(built, buildImageId(fill));
    }

    if (url.pathname.endsWith('/_ping')) {
      return new Response('OK', { headers: { 'api-version': '1.55' } });
    }

    if (url.pathname.endsWith('/export')) {
      return new Response('tar bytes');
    }

    // a build that never answers until its client goes
    if (url.searchParams.get('t') === 'imp/slow:latest') {
      slowBuild.started.resolve();

      await new Promise((resolve) => {
        request.signal.addEventListener('abort', resolve);
      });

      slowBuild.gone.resolve();

      return new Response(null, { status: 499 });
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
    hostImage: HOST_IMAGE,
    buildContextMaxBytes: CONTEXT_MAX_BYTES,
    ownedImages,
    log: (message) => {
      logged.push(message);
    },
  }),
});

interface ProxyInit {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | ReadableStream<Uint8Array>;
  readonly signal?: AbortSignal;
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

  engineImages.clear();
  inUse.clear();
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

test('a build streams its context and forwards no client header', async () => {
  const context = new Uint8Array(2 * 1024 ** 2).fill(7);

  const response = await sendToProxy('POST', BUILD_PATH, {
    headers: {
      'content-type': 'application/x-tar',
      'x-registry-config': 'e30=',
      'x-registry-auth': 'e30=',
      cookie: 'c=1',
    },
    body: context,
  });

  const answer: unknown = await response.json();

  expect(answer).toEqual({ received: context.length });
  expect(seen[0]?.target).toBe(BUILD_PATH);
  expect(seen[0]?.headers['content-type']).toBe('application/x-tar');
  expect(seen[0]?.headers['x-registry-config']).toBeUndefined();
  expect(seen[0]?.headers['x-registry-auth']).toBeUndefined();
  expect(seen[0]?.headers['cookie']).toBeUndefined();
});

test('a build without a Content-Type reaches the engine as a tar', async () => {
  const response = await sendToProxy('POST', BUILD_PATH, {
    body: new Blob([new Uint8Array(512)]).stream(),
  });

  // read to its end, so the tag lookup after a build is this test's
  await response.text();

  expect(response.status).toBe(200);
  expect(seen[0]?.headers['content-type']).toBe('application/x-tar');
});

// a form body would replace or add to the checked query: the engine reads r.Form
test('a build with a form body, which would replace or add to its query, never reaches the engine', async () => {
  const statuses: number[] = [];

  for (const contentType of [
    'application/x-www-form-urlencoded',
    'application/x-www-form-urlencoded; charset=utf-8',
    'multipart/form-data; boundary=x',
    'application/x-tar; charset=utf-8',
  ]) {
    const response = await sendToProxy('POST', BUILD_PATH, {
      headers: { 'content-type': contentType },
      body: 'networkmode=host&remote=http%3A%2F%2F127.0.0.1%3A9%2Fctx.tar&t=evil%3Alatest',
    });

    statuses.push(response.status);

    const refusal: unknown = await response.json();

    expect(refusal).toEqual({
      message: `imp-docker-proxy: a build body is a tar context, and Content-Type ${JSON.stringify(contentType)} is not application/x-tar`,
    });
  }

  expect(statuses).toEqual([403, 403, 403, 403]);
  expect(seen).toEqual([]);
  expect(logged).toHaveLength(4);
});

// the query passes as impd sends it; the body, encoded as fetch encodes a
// form, would move the build to the host's network, a remote context, a tag
// outside imp/ and the classic builder, which takes no frontend pin
test('a BuildKit build with an urlencoded or a multipart form body never reaches the engine', async () => {
  const fields: [string, string][] = [
    ['networkmode', 'host'],
    ['remote', 'http://127.0.0.1:9/ctx.tar'],
    ['t', 'evil:latest'],
    ['version', '1'],
  ];

  const multipart = new FormData();

  for (const [key, value] of fields) {
    multipart.append(key, value);
  }

  const statuses: number[] = [];
  const contentTypes: string[] = [];

  for (const form of [new URLSearchParams(fields), multipart]) {
    // fetch's own encoding, with its Content-Type and multipart boundary
    const encoded = new Request('http://docker/', { method: 'POST', body: form });

    const contentType = encoded.headers.get('content-type') ?? '';

    const body = await encoded.bytes();

    contentTypes.push(contentType);

    const response = await sendToProxy('POST', BUILD_PATH, {
      headers: { 'content-type': contentType },
      body,
    });

    statuses.push(response.status);

    const refusal: unknown = await response.json();

    expect(refusal).toEqual({
      message: `imp-docker-proxy: a build body is a tar context, and Content-Type ${JSON.stringify(contentType)} is not application/x-tar`,
    });
  }

  expect(contentTypes.map((value) => value.split(';')[0])).toEqual([
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ]);

  expect(statuses).toEqual([403, 403]);
  expect(seen).toEqual([]);
});

test('a client that goes ends its build on the engine', async () => {
  const client = new AbortController();

  const slowPath = BUILD_PATH.replace('imp%2Fx%3Alatest', 'imp%2Fslow%3Alatest');
  const response = sendToProxy('POST', slowPath, { body: 'ctx', signal: client.signal });

  await slowBuild.started.promise;

  client.abort();

  const failure = await response.catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  await slowBuild.gone.promise;
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

  const response = await sendToProxy('POST', BUILD_PATH, {
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

  // read to its end, so the lookup after a pull is this test's
  await pulled.text();

  expect(pulled.status).toBe(200);
  expect(withBody.status).toBe(403);

  const pulls = seen.filter((request) => request.method === 'POST');

  expect(pulls.map((request) => request.target)).toEqual([
    '/v1.55/images/create?fromImage=busybox&tag=latest',
  ]);

  expect(pulls[0]?.headers['x-registry-auth']).toBe('e30=');
});

// the IDs in the proxy's state file, as a restart would read them
function readOwnedIds(): string[] {
  return loadOwnedImages(ownedPath).has(buildImageId('c')) ? [buildImageId('c')] : [];
}

test('a pull of an image the engine lacked is the proxy’s: an rm removes it, without force', async () => {
  const pulled = await sendToProxy('POST', '/v1.55/images/create?fromImage=busybox&tag=1.37');

  await pulled.text();

  expect(readOwnedIds()).toEqual([buildImageId('c')]);

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.37');

  expect(removed.status).toBe(200);
  expect(seen.at(-2)?.target).toBe('/v1.55/images/busybox:1.37?force=0&noprune=1');
  expect(engineImages.size).toBe(0);
  expect(readOwnedIds()).toEqual([]);
});

test('an image the engine had before the pull stays the owner’s', async () => {
  writeEngineTag('busybox:1.37', buildImageId('c'));

  const pulled = await sendToProxy('POST', '/v1.55/images/create?fromImage=busybox&tag=1.37');

  await pulled.text();

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.37');

  expect(removed.status).toBe(403);
  expect(seen.some((request) => request.method === 'DELETE')).toBe(false);
  expect(engineImages.size).toBe(1);
});

test('a build’s tag is the proxy’s, and so is the image a rebuild leaves untagged, by its ID', async () => {
  const built = await sendToProxy('POST', BUILD_PATH, { body: new Uint8Array(512) });

  await built.text();

  // a rebuild moves the tag: the first image keeps no tag
  writeEngineTag('imp/x:latest', buildImageId('f'));

  const removed = await sendToProxy('DELETE', `/v1.55/images/${buildImageId('d')}`);

  expect(removed.status).toBe(200);
  expect(findEngineImageId(buildImageId('d'))).toBeUndefined();

  // the rebuilt image came from no build through the proxy
  const rebuilt = await sendToProxy('DELETE', '/v1.55/images/imp/x:latest');

  expect(rebuilt.status).toBe(403);
});

test('an owned ID the engine dropped by itself leaves the set when impd removes it', async () => {
  const goneId = buildImageId('7');

  ownedImages.add(goneId);

  const removed = await sendToProxy('DELETE', `/v1.55/images/${goneId}`);

  expect(removed.status).toBe(404);
  expect(loadOwnedImages(ownedPath).has(goneId)).toBe(false);
});

test('an image a container uses stays, with the engine’s 409, and stays the proxy’s', async () => {
  const pulled = await sendToProxy('POST', '/v1.55/images/create?fromImage=busybox&tag=1.37');

  await pulled.text();

  inUse.add('busybox:1.37');

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.37');

  expect(removed.status).toBe(409);
  expect(readOwnedIds()).toEqual([buildImageId('c')]);

  ownedImages.remove(buildImageId('c'));
});

test('force, the frontend’s and imp-host’s repositories and an image the engine lacks are refused', async () => {
  const frontendId = buildImageId('9');
  const hostId = buildImageId('8');

  writeEngineTag(DOCKERFILE_FRONTEND, frontendId);
  writeEngineTag('mine:1', frontendId);
  writeEngineTag(HOST_IMAGE, hostId);

  // owned as far as the proxy's set goes, kept all the same
  ownedImages.add(frontendId);
  ownedImages.add(hostId);

  const statuses = [];

  for (const target of [
    '/v1.55/images/busybox:1.37?force=1',
    `/v1.55/images/${DOCKERFILE_FRONTEND}`,
    '/v1.55/images/mine:1',
    `/v1.55/images/${frontendId}`,
    `/v1.55/images/${HOST_IMAGE}`,
    '/v1.55/images/nothing:1',
  ]) {
    const response = await sendToProxy('DELETE', target);

    statuses.push(response.status);
  }

  expect(statuses).toEqual([403, 403, 403, 403, 403, 404]);
  expect(seen.some((request) => request.method === 'DELETE')).toBe(false);

  ownedImages.remove(frontendId);
  ownedImages.remove(hostId);
});

test('an Upgrade, a refused route and a refused param never reach the engine', async () => {
  const upgrade = await sendToProxy('POST', BUILD_PATH, {
    headers: { upgrade: 'h2c', connection: 'Upgrade' },
  });

  const start = await sendToProxy('POST', `/v1.55/containers/${OWN_ID}/start`);
  const remote = await sendToProxy('POST', `${BUILD_PATH}&remote=https%3A%2F%2Fx`);

  expect([upgrade.status, start.status, remote.status]).toEqual([403, 403, 403]);

  const refusal: unknown = await start.json();

  expect(refusal).toEqual({
    message: `imp-docker-proxy: POST /containers/${OWN_ID}/start is not a call impd makes`,
  });

  expect(seen).toEqual([]);
});
