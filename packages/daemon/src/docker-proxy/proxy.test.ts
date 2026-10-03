import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCKERFILE_FRONTEND } from './dockerfile-frontend';
import { loadOwnedReferences } from './owned-references';
import { PROXY_LABEL, createDockerProxy } from './proxy';
import { normalizeReference } from './rules';

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
const ownedPath = join(dir, 'owned-references.json');

const ownedReferences = loadOwnedReferences(ownedPath, (message) => {
  logged.push(message);
});

const logged: string[] = [];
const HOST_IMAGE = 'ghcr.io/zgeoff/imp-host:latest';

// the engine's references: the image each names, and when it was set
const engineTags = new Map<string, { readonly id: string; readonly taggedAt: string }>();

const clock = { tick: 0 };

// references the engine refuses to remove, as when a container uses them
const inUse = new Set<string>();

// sets `tag` to `id`, as a pull, a build or a `docker tag` does: the engine
// keeps one tag time per image, which every name on it then shows
function writeEngineTag(tag: string, id: string): void {
  clock.tick += 1;

  const taggedAt = `2026-10-04T00:00:${String(clock.tick).padStart(2, '0')}Z`;

  for (const [name, value] of engineTags) {
    if (value.id === id) {
      engineTags.set(name, { id, taggedAt });
    }
  }

  engineTags.set(tag, { id, taggedAt });
}

// the digest a pull of image c brings with it, per repository
const PULLED_DIGEST = `sha256:${'d'.repeat(64)}`;

function listNames(id: string): string[] {
  return [...engineTags].filter(([, value]) => value.id === id).map(([name]) => name);
}

function listTags(id: string): string[] {
  return listNames(id).filter((name) => !name.includes('@'));
}

function listDigests(id: string): string[] {
  return listNames(id).filter((name) => name.includes('@'));
}

// removes `name` as the engine does: a repository's last tag on the image
// takes the repository's digest references with it
function removeEngineName(name: string): void {
  const removed = engineTags.get(name);

  engineTags.delete(name);

  if (removed === undefined || name.includes('@')) {
    return;
  }

  const repository = name.slice(0, name.lastIndexOf(':'));
  const tags = listTags(removed.id).filter((tag) => tag.startsWith(`${repository}:`));

  if (tags.length > 0) {
    return;
  }

  for (const digest of listDigests(removed.id)) {
    if (digest.startsWith(`${repository}@`)) {
      engineTags.delete(digest);
    }
  }
}

// an engine that leaves out each image's tag time, as an older one may
const engineQuirks = { omitsTagTime: false };

function readEngineImage(name: string): Response {
  const tagged =
    engineTags.get(name) ?? [...engineTags.values()].find((value) => value.id === name);

  if (tagged === undefined) {
    return new Response('no such image', { status: 404 });
  }

  return Response.json({
    Id: tagged.id,
    RepoTags: listTags(tagged.id),
    RepoDigests: listDigests(tagged.id),
    ...(!engineQuirks.omitsTagTime && { Metadata: { LastTagTime: tagged.taggedAt } }),
  });
}

function buildImageId(fill: string): string {
  return `sha256:${fill.repeat(64)}`;
}

// a slow build on the engine: it started, and its client went
const slowBuild = { started: Promise.withResolvers<void>(), gone: Promise.withResolvers<void>() };

// a build that waits for the test, then fails without moving its tag
const heldBuild = {
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
};

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

    if (request.method === 'GET' && url.pathname.endsWith('/images/json')) {
      const ids = new Set([...engineTags.values()].map((value) => value.id));

      return Response.json(
        [...ids].map((id) => ({ Id: id, RepoTags: listTags(id), RepoDigests: listDigests(id) })),
      );
    }

    const inspected = /\/images\/(?<name>.+)\/json$/v.exec(url.pathname)?.groups?.['name'];

    if (request.method === 'GET' && inspected !== undefined) {
      return readEngineImage(inspected);
    }

    const removed = /\/images\/(?<name>.+)$/v.exec(url.pathname)?.groups?.['name'];

    if (request.method === 'DELETE' && removed !== undefined) {
      if (!engineTags.has(removed)) {
        return new Response('no such image', { status: 404 });
      }

      if (inUse.has(removed)) {
        return Response.json({ message: 'image is being used by a container' }, { status: 409 });
      }

      removeEngineName(removed);

      return Response.json([{ Untagged: removed }]);
    }

    if (url.pathname.endsWith('/images/create')) {
      const fromImage = url.searchParams.get('fromImage') ?? '';
      const tag = url.searchParams.get('tag') ?? '';

      writeEngineTag(`${fromImage}:${tag}`, buildImageId('c'));
      writeEngineTag(`${fromImage}@${PULLED_DIGEST}`, buildImageId('c'));
    }

    const built = url.searchParams.get('t');

    // imp/slow never ends. imp/fail moves its tag and ends on an error, and
    // imp/raced says it made d while its tag moved to e
    if (url.pathname.endsWith('/build') && built === 'imp/held:latest') {
      heldBuild.started.resolve();

      await heldBuild.release.promise;

      return buildBuildAnswer(body.length, undefined);
    }

    if (url.pathname.endsWith('/build') && built !== null && built !== 'imp/slow:latest') {
      const fill = built === 'imp/x:latest' ? 'd' : 'e';

      writeEngineTag(built, buildImageId(fill));

      const madeFill = built === 'imp/fail:latest' ? undefined : 'd';

      return buildBuildAnswer(body.length, madeFill);
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

// a BuildKit build's answer: a trace line, then its end, split mid-line
function buildBuildAnswer(received: number, madeFill: string | undefined): Response {
  const end =
    madeFill === undefined
      ? { error: 'exit code: 1', errorDetail: { message: 'exit code: 1' } }
      : { id: 'moby.image.id', aux: { ID: buildImageId(madeFill) } };

  const text = `${JSON.stringify({ id: 'moby.buildkit.trace', aux: 'e30=', received })}\n${JSON.stringify(end)}\n`;
  const split = text.length - 20;

  return new Response(
    new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(text.slice(0, split)));
        controller.enqueue(new TextEncoder().encode(text.slice(split)));
        controller.close();
      },
    }),
  );
}

const proxy = Bun.serve({
  unix: proxySocket,
  maxRequestBodySize: CONTEXT_MAX_BYTES * 2,
  fetch: createDockerProxy({
    upstreamSocket: engineSocket,
    token: TOKEN,
    hostImage: HOST_IMAGE,
    buildContextMaxBytes: CONTEXT_MAX_BYTES,
    ownedReferences,
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

  engineTags.clear();
  inUse.clear();

  engineQuirks.omitsTagTime = false;
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

  const answer = await response.text();

  // the proxy looks the tag up before and after: the build is the one POST
  const build = seen.find((request) => request.method === 'POST');

  expect(answer).toContain(`"received":${String(context.length)}`);
  expect(build?.target).toBe(BUILD_PATH);
  expect(build?.headers['content-type']).toBe('application/x-tar');
  expect(build?.headers['x-registry-config']).toBeUndefined();
  expect(build?.headers['x-registry-auth']).toBeUndefined();
  expect(build?.headers['cookie']).toBeUndefined();
});

test('a build without a Content-Type reaches the engine as a tar', async () => {
  const response = await sendToProxy('POST', BUILD_PATH, {
    body: new Blob([new Uint8Array(512)]).stream(),
  });

  // read to its end, so the tag lookup after a build is this test's
  await response.text();

  expect(response.status).toBe(200);

  expect(seen.find((request) => request.method === 'POST')?.headers['content-type']).toBe(
    'application/x-tar',
  );
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

// what the proxy's state file holds for a reference, as a restart reads it
function readOwned(reference: string) {
  return loadOwnedReferences(ownedPath, () => {}).read(reference);
}

async function sendPull(fromImage: string, tag: string): Promise<void> {
  const pulled = await sendToProxy(
    'POST',
    `/v1.55/images/create?fromImage=${fromImage}&tag=${tag}`,
  );

  await pulled.text();
}

test('a pull of a reference the engine lacked is the proxy’s: an rm removes it, without force', async () => {
  await sendPull('busybox', '1.36');

  expect(readOwned('docker.io/library/busybox:1.36')).toMatchObject({ id: buildImageId('c') });

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.36');

  expect(removed.status).toBe(200);

  expect(seen.findLast((request) => request.method === 'DELETE')?.target).toBe(
    '/v1.55/images/busybox:1.36?force=0&noprune=1',
  );

  expect(engineTags.size).toBe(0);
  expect(readOwned('docker.io/library/busybox:1.36')).toBeUndefined();
  expect(readOwned(`docker.io/library/busybox@${PULLED_DIGEST}`)).toBeUndefined();
});

test('a digest the host pulled stays when the proxy pulls a tag of its image', async () => {
  writeEngineTag(`busybox@${PULLED_DIGEST}`, buildImageId('c'));

  await sendPull('busybox', '1.36');

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.36');
  const byId = await sendToProxy('DELETE', `/v1.55/images/${buildImageId('c')}`);

  expect([removed.status, byId.status]).toEqual([403, 403]);
  expect(readOwned(`docker.io/library/busybox@${PULLED_DIGEST}`)).toBeUndefined();
  expect(engineTags.has(`busybox@${PULLED_DIGEST}`)).toBe(true);
  expect(engineTags.has('busybox:1.36')).toBe(true);
});

test('a reference the engine had before the pull stays the owner’s', async () => {
  writeEngineTag('busybox:1.36', buildImageId('c'));

  await sendPull('busybox', '1.36');

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.36');

  expect(removed.status).toBe(403);
  expect(seen.some((request) => request.method === 'DELETE')).toBe(false);
  expect(engineTags.has('busybox:1.36')).toBe(true);
});

test('the owner’s tag on an image the proxy pulled stays, by its name or by the ID', async () => {
  // the owner had alpine:3.20; the proxy pulled alpine:3.20.3, the same image
  writeEngineTag('alpine:3.20', buildImageId('c'));

  await sendPull('alpine', '3.20.3');

  const statuses = [];

  for (const target of ['/v1.55/images/alpine:3.20', `/v1.55/images/${buildImageId('c')}`]) {
    const response = await sendToProxy('DELETE', target);

    statuses.push(response.status);
  }

  expect(statuses).toEqual([403, 403]);
  expect(seen.some((request) => request.method === 'DELETE')).toBe(false);

  // the proxy's own name goes; the owner's keeps the image
  const own = await sendToProxy('DELETE', '/v1.55/images/alpine:3.20.3');

  expect(own.status).toBe(200);
  expect([...engineTags.keys()].toSorted()).toEqual([`alpine:3.20`, `alpine@${PULLED_DIGEST}`]);
});

test('a tag the owner sets after the proxy’s pull keeps the image, under both names', async () => {
  await sendPull('busybox', '1.36');

  writeEngineTag('mine:1', buildImageId('c'));

  const statuses = [];

  for (const target of ['/v1.55/images/busybox:1.36', `/v1.55/images/${buildImageId('c')}`]) {
    const response = await sendToProxy('DELETE', target);

    statuses.push(response.status);
  }

  expect(statuses).toEqual([403, 403]);

  expect([...engineTags.keys()].toSorted()).toEqual([
    'busybox:1.36',
    `busybox@${PULLED_DIGEST}`,
    'mine:1',
  ]);
});

test('two references the proxy pulled for one image are both its own', async () => {
  await sendPull('alpine', '3.20.3');
  await sendPull('alpine', '3.20');

  const removed = await sendToProxy('DELETE', `/v1.55/images/${buildImageId('c')}`);

  expect(removed.status).toBe(200);
  expect(engineTags.size).toBe(0);
});

test('a stale reference stays stale when the proxy pulls another name for its image', async () => {
  await sendPull('busybox', '1.36');

  // outside the proxy: the same name and image, set again
  engineTags.delete('busybox:1.36');

  writeEngineTag('busybox:1.36', buildImageId('c'));

  await sendPull('busybox', '1');

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.36');

  expect(removed.status).toBe(403);
  expect(engineTags.has('busybox:1.36')).toBe(true);
});

test('a failed build of the owner’s tag is not the proxy’s, though a pull moved the image’s time', async () => {
  writeEngineTag('imp/held:latest', buildImageId('c'));

  const held = `/v1.55/build?${new URLSearchParams({
    t: 'imp/held:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  }).toString()}`;

  const building = sendToProxy('POST', held, { body: new Uint8Array(512) });

  await heldBuild.started.promise;

  // a pull of another name for the same image, while the build runs
  await sendPull('busybox', 'alias');

  heldBuild.release.resolve();

  const answer = await building;

  await answer.text();

  const removed = await sendToProxy('DELETE', '/v1.55/images/imp/held:latest');

  expect(readOwned('docker.io/imp/held:latest')).toBeUndefined();
  expect(removed.status).toBe(403);
  expect(engineTags.has('imp/held:latest')).toBe(true);
});

test('an engine that gives no tag time makes no reference the proxy’s', async () => {
  engineQuirks.omitsTagTime = true;

  await sendPull('busybox', '1.36');

  expect(readOwned('docker.io/library/busybox:1.36')).toBeUndefined();
  expect(logged.join('\n')).toContain('the engine gave no tag time');

  // a record from before, while the engine gave a time, is refused too
  ownedReferences.write(
    'docker.io/library/busybox:1.36',
    { id: buildImageId('c'), taggedAt: '' },
    undefined,
  );

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.36');

  expect(removed.status).toBe(403);
  expect(engineTags.has('busybox:1.36')).toBe(true);
});

test('a reference the owner removed and pulled again is the owner’s', async () => {
  await sendPull('busybox', '1.36');

  // outside the proxy: the same name and image, set again
  engineTags.delete('busybox:1.36');

  writeEngineTag('busybox:1.36', buildImageId('c'));

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.36');

  expect(removed.status).toBe(403);
  expect(engineTags.has('busybox:1.36')).toBe(true);
  expect(readOwned('docker.io/library/busybox:1.36')).toBeUndefined();
});

test('a build’s tag is the proxy’s; by ID, an image passes only when every tag is', async () => {
  const built = await sendToProxy('POST', BUILD_PATH, { body: new Uint8Array(512) });

  await built.text();

  expect(readOwned('docker.io/imp/x:latest')).toMatchObject({ id: buildImageId('d') });

  const byId = await sendToProxy('DELETE', `/v1.55/images/${buildImageId('d')}`);

  expect(byId.status).toBe(200);
  expect(engineTags.size).toBe(0);
});

test('a failed build over the owner’s tag makes nothing the proxy’s', async () => {
  // the owner's tag before the build, which the failed build moves
  writeEngineTag('imp/fail:latest', buildImageId('f'));

  const failing = `/v1.55/build?${new URLSearchParams({
    t: 'imp/fail:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  }).toString()}`;

  const built = await sendToProxy('POST', failing, { body: new Uint8Array(512) });

  await built.text();

  expect(readOwned('docker.io/imp/fail:latest')).toBeUndefined();
});

test('a tag that moved to an image other than the one the build made is not the proxy’s', async () => {
  const raced = `/v1.55/build?${new URLSearchParams({
    t: 'imp/raced:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  }).toString()}`;

  const built = await sendToProxy('POST', raced, { body: new Uint8Array(512) });

  await built.text();

  expect(readOwned('docker.io/imp/raced:latest')).toBeUndefined();
});

test('a reference the engine dropped leaves the record when impd removes it', async () => {
  await sendPull('busybox', '1.36');

  engineTags.delete('busybox:1.36');

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.36');

  expect(removed.status).toBe(404);
  expect(readOwned('docker.io/library/busybox:1.36')).toBeUndefined();
});

test('an image a container uses stays, with the engine’s 409, and stays the proxy’s', async () => {
  await sendPull('busybox', '1.36');

  inUse.add('busybox:1.36');

  const removed = await sendToProxy('DELETE', '/v1.55/images/busybox:1.36');

  expect(removed.status).toBe(409);
  expect(readOwned('docker.io/library/busybox:1.36')).toBeDefined();

  ownedReferences.remove('docker.io/library/busybox:1.36');
});

test('force, the frontend’s and imp-host’s repositories and an image the engine lacks are refused', async () => {
  const frontendId = buildImageId('9');

  writeEngineTag(DOCKERFILE_FRONTEND, frontendId);
  writeEngineTag('mine:1', frontendId);
  writeEngineTag(HOST_IMAGE, buildImageId('8'));

  // recorded as the proxy's, refused all the same
  for (const [reference, id] of [
    ['mine:1', frontendId],
    [HOST_IMAGE, buildImageId('8')],
  ] as const) {
    const tagged = engineTags.get(reference);

    ownedReferences.write(
      normalizeReference(reference),
      { id, taggedAt: tagged?.taggedAt ?? '' },
      undefined,
    );
  }

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

  ownedReferences.remove(normalizeReference('mine:1'));
  ownedReferences.remove(normalizeReference(HOST_IMAGE));
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
