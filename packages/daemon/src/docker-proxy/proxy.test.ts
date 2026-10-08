import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { startStubDockerEngine } from '../test-utils/start-stub-docker-engine';
import { DOCKERFILE_FRONTEND } from './dockerfile-frontend';
import { PROXY_LABEL, createDockerProxy } from './proxy';
import type { DockerProxyOptions } from './proxy';
import { readProxyRefusal } from './refusal';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'docker-proxy-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  // what an export streams, for the tests that export a container
  const engine = startStubDockerEngine({ dir, exportBytes: new TextEncoder().encode('tar bytes') });

  stack.defer(() => engine.stop());

  const logged: string[] = [];

  // imp-docker-proxy on a unix socket as its main serves it; the returned
  // send carries a request to it over a real connection
  const startProxy = (options: Readonly<DockerProxyOptions>) => {
    const socket = join(dir, 'proxy.sock');

    // Bun's types leave idleTimeout off unix servers, but it applies there too
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    const server = Bun.serve({
      unix: socket,
      fetch: createDockerProxy(options),
      maxRequestBodySize: options.buildContextMaxBytes + 1024 ** 2,
      idleTimeout: 0,
    } as unknown as Bun.Serve.Options<undefined>);

    stack.defer(() => server.stop(true));

    return (request: Request) =>
      fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        duplex: 'half',
        signal: request.signal,
        unix: socket,
      });
  };

  return {
    dir,
    engine,
    logged,
    log: (message: string) => {
      logged.push(message);
    },
    startProxy,
  };
}

test('it relays a ping to the engine with its API version', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(new Request('http://docker/_ping', { method: 'HEAD' }));

  expect(response.headers.get('api-version')).toBe('1.55');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it relays a version call to the engine', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(new Request('http://docker/v1.55/version'));
  const version: unknown = await response.json();

  expect(version).toStrictEqual({ ApiVersion: '1.55', Os: 'linux', Arch: 'amd64' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it relays an image inspect to the engine by the image name', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  await proxy(new Request('http://docker/v1.55/images/docker.io/library/busybox:1.37/json'));

  expect(ctx.engine.seen.map((request) => `${request.method} ${request.target}`)).toStrictEqual([
    'GET /v1.55/images/docker.io/library/busybox:1.37/json',
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it sends the engine a create body of its own, with its label and no network', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        Image: 'busybox',
        Cmd: ['/bin/true'],
        AttachStdout: true,
        HostConfig: { NetworkMode: 'default' },
      }),
    }),
  );

  const [created] = ctx.engine.seen;

  invariant(created);

  expect(response.status).toBe(201);
  expect(ctx.engine.seen).toHaveLength(1);
  expect(created.target).toBe('/v1.55/containers/create');
  expect(ctx.engine.unexpected).toStrictEqual([]);

  expect(JSON.parse(new TextDecoder().decode(created.body))).toStrictEqual({
    Image: 'busybox',
    Cmd: ['/bin/true'],
    Labels: { [PROXY_LABEL]: 'test-token' },
    HostConfig: { NetworkMode: 'none', RestartPolicy: { Name: 'no' } },
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it forwards no client header on a create', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      headers: { authorization: 'Bearer x', cookie: 'c=1' },
      body: JSON.stringify({ Image: 'busybox', Cmd: ['/bin/true'] }),
    }),
  );

  const [created] = ctx.engine.seen;

  invariant(created);

  expect(created.headers).not.toContainAnyKeys(['authorization', 'cookie']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create with a bind, and logs the refusal', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({
        Image: 'busybox',
        Cmd: ['/bin/true'],
        HostConfig: { Binds: ['/:/host'] },
      }),
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);
  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: HostConfig.Binds is set' });
  expect(ctx.engine.seen).toStrictEqual([]);

  expect(ctx.logged).toStrictEqual([
    'refused POST /v1.55/containers/create: HostConfig.Binds is set',
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create body over 1 MiB sent chunked', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const chunk = new Uint8Array(64 * 1024).fill(32);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 20; index += 1) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', { method: 'POST', body }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: 'imp-docker-proxy: the create body is larger than 1048576 bytes',
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create body that is not JSON', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', { method: 'POST', body: '{nope' }),
  );

  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: the create body is not JSON' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create body with no Image', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({ Cmd: ['/bin/true'] }),
    }),
  );

  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: Image is missing' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it exports a container it created by its full ID', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'a'.repeat(64), labels: { [PROXY_LABEL]: 'test-token' } });

  const response = await proxy(new Request('http://docker/v1.55/containers/aaaa/export'));
  const tar = await response.text();

  expect(tar).toBe('tar bytes');

  expect(ctx.engine.seen.map((request) => `${request.method} ${request.target}`)).toStrictEqual([
    'GET /v1.55/containers/aaaa/json',
    `GET /v1.55/containers/${'a'.repeat(64)}/export`,
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it removes a container it created by its full ID, with its volumes', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'a'.repeat(64), labels: { [PROXY_LABEL]: 'test-token' } });

  await proxy(new Request('http://docker/v1.55/containers/aaaa?force=1', { method: 'DELETE' }));

  expect(ctx.engine.seen.map((request) => `${request.method} ${request.target}`)).toStrictEqual([
    'GET /v1.55/containers/aaaa/json',
    `DELETE /v1.55/containers/${'a'.repeat(64)}?force=1&v=1`,
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// another proxy's token, which an image's own label could also set
test('it refuses the export of a container whose label holds another token', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'b'.repeat(64), labels: { [PROXY_LABEL]: '1' } });

  const response = await proxy(new Request('http://docker/v1.55/containers/bbbb/export'));
  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: 'imp-docker-proxy: container bbbb was not created by this proxy',
  });

  expect(ctx.engine.seen.map((request) => `${request.method} ${request.target}`)).toStrictEqual([
    'GET /v1.55/containers/bbbb/json',
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses the removal of a container whose label holds another token', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'b'.repeat(64), labels: { [PROXY_LABEL]: '1' } });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/bbbb?force=1', { method: 'DELETE' }),
  );

  expect(response.status).toBe(403);
  expect(ctx.engine.hasContainer('b'.repeat(64))).toBe(true);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses the removal of a container the engine does not have', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/cccc?force=1', { method: 'DELETE' }),
  );

  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({
    message: 'imp-docker-proxy: container cccc was not created by this proxy',
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a removal with a param docker rm -f does not send', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/aaaa?force=1&link=1', { method: 'DELETE' }),
  );

  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: param link is not allowed' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a param on a call that takes none', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(new Request('http://docker/v1.55/version?format=x'));
  const refusal: unknown = await response.json();

  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: param format is not allowed' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it streams a build context whole to the engine as the build body', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const context = new Uint8Array(2 * 1024 ** 2).fill(7);

  await proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-tar' },
      body: context,
    }),
  );

  expect(ctx.engine.seen).toMatchObject([
    {
      target: `/v1.55/build?${query.toString()}`,
      headers: { 'content-type': 'application/x-tar' },
      body: context,
    },
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it forwards no client header on a build', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  await proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-tar',
        'x-registry-config': 'e30=',
        'x-registry-auth': 'e30=',
        cookie: 'c=1',
      },
      body: 'ctx',
    }),
  );

  const [build] = ctx.engine.seen;

  invariant(build);

  expect(build.headers).not.toContainAnyKeys(['x-registry-config', 'x-registry-auth', 'cookie']);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it sends a build without a Content-Type to the engine as a tar', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const body = new Blob([new Uint8Array(512)]).stream();

  await proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, {
      method: 'POST',
      body,
    }),
  );

  expect(ctx.engine.seen).toMatchObject([{ headers: { 'content-type': 'application/x-tar' } }]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// a form body would replace or add to the checked query: the engine reads r.Form
test.each([
  ['application/x-www-form-urlencoded'],
  ['application/x-www-form-urlencoded; charset=utf-8'],
  ['multipart/form-data; boundary=x'],
  ['application/x-tar; charset=utf-8'],
])('it refuses a build whose body is sent as %s', async (contentType) => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const response = await proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: 'networkmode=host&remote=http%3A%2F%2F127.0.0.1%3A9%2Fctx.tar&t=evil%3Alatest',
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: `imp-docker-proxy: a build body is a tar context, and Content-Type ${JSON.stringify(contentType)} is not application/x-tar`,
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// the body, encoded as fetch encodes a form, would move the build to the
// host's network, a remote context, a tag outside imp/ and the classic builder
test('it refuses a build with a form body as fetch encodes a URLSearchParams', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const response = await proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, {
      method: 'POST',
      body: new URLSearchParams({ networkmode: 'host', t: 'evil:latest', version: '1' }),
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message:
      'imp-docker-proxy: a build body is a tar context, and Content-Type "application/x-www-form-urlencoded;charset=UTF-8" is not application/x-tar',
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a build with a multipart form body as fetch encodes a FormData', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const form = new FormData();

  form.append('networkmode', 'host');
  form.append('remote', 'http://127.0.0.1:9/ctx.tar');

  const request = new Request(`http://docker/v1.55/build?${query.toString()}`, {
    method: 'POST',
    body: form,
  });

  const response = await proxy(request);
  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: expect.stringMatching(
      /^imp-docker-proxy: a build body is a tar context, and Content-Type "multipart\/form-data; ?boundary=[^"]+" is not application\/x-tar$/v,
    ) as unknown,
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it ends a build on the engine when its client goes', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const started = Promise.withResolvers<void>();
  const gone = Promise.withResolvers<void>();

  // a build that never answers until its client goes
  ctx.engine.setAnswer(async (request, seen) => {
    if (!seen.target.startsWith('/v1.55/build')) {
      return null;
    }

    started.resolve();

    await new Promise((resolve) => {
      request.signal.addEventListener('abort', resolve);
    });

    gone.resolve();

    return new Response(null, { status: 499 });
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const client = new AbortController();

  const building = proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, {
      method: 'POST',
      body: 'ctx',
      signal: client.signal,
    }),
  );

  await started.promise;

  // the client drops its connection to the proxy
  client.abort();

  await building.catch(() => {});

  await expect(gone.promise).toResolve();

  expect(building).rejects.toMatchObject({ name: 'AbortError', code: 20 });
  expect(ctx.engine.unexpected).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it cuts off a chunked build context over the limit', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const chunk = new Uint8Array(256 * 1024);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 6; index += 1) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

  await proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, { method: 'POST', body }),
  );

  const seen = await waitFor(() => {
    invariant(ctx.engine.seen[0]);

    return ctx.engine.seen[0];
  });

  expect(seen.body.byteLength).toBeLessThanOrEqual(1024 ** 2);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it answers a chunked build context over the limit with a 413 that names the limit', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const chunk = new Uint8Array(256 * 1024);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < 6; index += 1) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

  const response = await proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, { method: 'POST', body }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(413);

  expect(refusal).toStrictEqual({
    message:
      'imp-docker-proxy: the build context is larger than 1048576 bytes (IMP_BUILD_CONTEXT_MAX_MIB)',
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it forwards a pull with its fromImage, tag and registry auth', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  await proxy(
    new Request('http://docker/v1.55/images/create?fromImage=busybox&tag=latest', {
      method: 'POST',
      headers: { 'x-registry-auth': 'e30=', cookie: 'c=1' },
    }),
  );

  const [pull] = ctx.engine.seen;

  invariant(pull);

  expect(pull.target).toBe('/v1.55/images/create?fromImage=busybox&tag=latest');
  expect(pull.headers['x-registry-auth']).toBe('e30=');
  expect(pull.headers['cookie'] ?? null).toBe(null);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a pull with a body', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/images/create?fromImage=busybox&tag=latest', {
      method: 'POST',
      body: 'x',
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);
  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: a pull takes no body' });
  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it ends a create the engine never answers at the control deadline, and the engine sees it go', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    controlCallMs: 50,
    log: ctx.log,
  });

  const gone = Promise.withResolvers<void>();

  // a create that never answers until its caller goes
  ctx.engine.setAnswer(async (request) => {
    await new Promise((resolve) => {
      request.signal.addEventListener('abort', resolve);
    });

    gone.resolve();

    return new Response(null, { status: 499 });
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({ Image: 'busybox:1.37', Cmd: ['/bin/true'] }),
    }),
  );

  await gone.promise;

  expect(response.status).toBe(502);
  expect(ctx.logged).toHaveLength(1);
  expect(ctx.logged[0]).toStartWith('error on POST /v1.55/containers/create: ');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// Bun's fetch gives up on an answer silent for 360 s, as a build's quiet RUN
// step is; images/docker-build.test.ts checks that limit in a child Bun
test('it holds a build, a pull and an export past the control deadline that ends a create', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    controlCallMs: 50,
    log: ctx.log,
  });

  await ctx.engine.addContainer({ id: 'a'.repeat(64), labels: { [PROXY_LABEL]: 'test-token' } });

  const release = Promise.withResolvers<void>();

  // the long calls answer once released; a create answers only when it goes
  ctx.engine.setAnswer(async (request, seen) => {
    const isLong =
      seen.target.startsWith('/v1.55/build') ||
      seen.target.startsWith('/v1.55/images/create') ||
      seen.target.endsWith('/export');

    if (isLong) {
      await release.promise;

      return null;
    }

    if (seen.target === '/v1.55/containers/create') {
      await new Promise((resolve) => {
        request.signal.addEventListener('abort', resolve);
      });

      return new Response(null, { status: 499 });
    }

    return null;
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const long = [
    proxy(
      new Request(`http://docker/v1.55/build?${query.toString()}`, { method: 'POST', body: 'ctx' }),
    ),
    proxy(
      new Request('http://docker/v1.55/images/create?fromImage=busybox&tag=latest', {
        method: 'POST',
      }),
    ),
    proxy(new Request('http://docker/v1.55/containers/aaaa/export')),
  ];

  await waitFor(() => {
    expect(ctx.engine.seen).toHaveLength(4);
  });

  const created = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({ Image: 'busybox:1.37', Cmd: ['/bin/true'] }),
    }),
  );

  release.resolve();

  const answered = await Promise.all(long);

  expect(created.status).toBe(502);
  expect(answered.map((response) => response.status)).toStrictEqual([200, 200, 200]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it answers 502 with the engine failure when the engine is unreachable', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: join(ctx.dir, 'no-engine.sock'),
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(new Request('http://docker/_ping'));
  const failure: unknown = await response.json();

  expect(response.status).toBe(502);

  expect(failure).toStrictEqual({
    message: expect.stringMatching(/^imp-docker-proxy: the engine call failed: /v) as unknown,
  });

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create from another image under imp isolation', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({ Image: 'busybox:1.37', Cmd: ['/bin/true'] }),
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: `imp-docker-proxy: a create from busybox:1.37 is refused: under IMP_BUILD_ISOLATION=imp the proxy creates only from IMP_BUILD_IMAGE, ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it passes a create from IMP_BUILD_IMAGE by its digest under imp isolation', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({
        Image: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
        Cmd: ['/bin/true'],
      }),
    }),
  );

  expect(response.status).toBe(201);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a pull of another image under imp isolation', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/images/create?fromImage=busybox&tag=1.37', {
      method: 'POST',
    }),
  );

  expect(response.status).toBe(403);
  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it forwards a pull of IMP_BUILD_IMAGE by its digest under imp isolation', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  await proxy(
    new Request(
      `http://docker/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=${digest}`,
      { method: 'POST' },
    ),
  );

  expect(ctx.engine.seen.map((request) => request.target)).toStrictEqual([
    `/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=${encodeURIComponent(digest)}`,
  ]);

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses every build under imp isolation', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
  });

  const response = await proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-tar' },
      body: 'context',
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message:
      'imp-docker-proxy: a build is refused: under IMP_BUILD_ISOLATION=imp impd builds in builder imps',
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// #173: impd reads the proxy's message alone back out of its body and out
// of the CLI's stderr, and answers it as the client's BAD_REQUEST
test('it refuses a pull from a loopback registry with a refusal that reads back alone', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/images/create?fromImage=localhost%3A5320%2Fx&tag=1', {
      method: 'POST',
    }),
  );

  const body = await response.text();

  expect(response.status).toBe(403);
  expect(ctx.engine.seen).toStrictEqual([]);

  expect(readProxyRefusal(body)).toBe(
    "imp-docker-proxy: registry localhost:5320 is the host's own",
  );

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a create from a loopback registry with a refusal the CLI stderr reads back', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/containers/create', {
      method: 'POST',
      body: JSON.stringify({ Image: 'localhost:5320/x:1', Cmd: ['/bin/true'] }),
    }),
  );

  const body = await response.text();

  expect(response.status).toBe(403);
  expect(ctx.engine.seen).toStrictEqual([]);

  expect(readProxyRefusal(`Error response from daemon: ${body}`)).toBe(
    "imp-docker-proxy: registry localhost:5320 is the host's own",
  );

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses an Upgrade request', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request('http://docker/v1.55/_ping', {
      headers: { upgrade: 'h2c', connection: 'Upgrade' },
    }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: 'imp-docker-proxy: an Upgrade request is not a call impd makes',
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a route impd does not call', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const response = await proxy(
    new Request(`http://docker/v1.55/containers/${'a'.repeat(64)}/start`, { method: 'POST' }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);

  expect(refusal).toStrictEqual({
    message: `imp-docker-proxy: POST /containers/${'a'.repeat(64)}/start is not a call impd makes`,
  });

  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('it refuses a build with a param that moves its context', async () => {
  const ctx = await setupTest();

  const proxy = ctx.startProxy({
    upstreamSocket: ctx.engine.socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: null,
    buildContextMaxBytes: 4 * 1024 ** 2,
    log: ctx.log,
  });

  const query = new URLSearchParams({
    t: 'imp/x:latest',
    version: '2',
    buildargs: JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }),
    remote: 'https://x',
  });

  const response = await proxy(
    new Request(`http://docker/v1.55/build?${query.toString()}`, { method: 'POST' }),
  );

  const refusal: unknown = await response.json();

  expect(response.status).toBe(403);
  expect(refusal).toStrictEqual({ message: 'imp-docker-proxy: param remote is not allowed' });
  expect(ctx.engine.seen).toStrictEqual([]);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});
