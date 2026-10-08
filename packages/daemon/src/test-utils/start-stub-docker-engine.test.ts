import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { z } from 'zod';
import { PinInspectSchema } from '../images/image-pin';
import { startStubDockerEngine } from './start-stub-docker-engine';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-engine-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const engine = startStubDockerEngine({ dir, exportBytes: new TextEncoder().encode('tar bytes') });

  stack.defer(() => engine.stop());

  return { dir, engine };
}

test('it answers a ping with the API version header', async () => {
  const ctx = await setupTest();
  const response = await fetch('http://docker/_ping', { unix: ctx.engine.socket, method: 'HEAD' });

  expect(response.status).toBe(200);
  expect(response.headers.get('api-version')).toBe('1.55');
});

test('it names its socket in DOCKER_HOST form', async () => {
  const ctx = await setupTest();

  expect(ctx.engine.dockerHost).toBe(`unix://${ctx.engine.socket}`);
});

test('it answers a versioned version call with the engine platform', async () => {
  const ctx = await setupTest();
  const response = await fetch('http://docker/v1.55/version', { unix: ctx.engine.socket });
  const answer: unknown = await response.json();

  expect(answer).toStrictEqual({ ApiVersion: '1.55', Os: 'linux', Arch: 'amd64' });
});

test('it records each request with its target, headers and body', async () => {
  const ctx = await setupTest();

  await fetch('http://docker/v1.55/build?t=imp%2Fx%3Alatest', {
    unix: ctx.engine.socket,
    method: 'POST',
    headers: { 'content-type': 'application/x-tar' },
    body: 'the context',
  });

  // the headers hold what fetch adds, such as host and content-length
  expect(ctx.engine.seen).toMatchObject([
    {
      method: 'POST',
      target: '/v1.55/build?t=imp%2Fx%3Alatest',
      headers: { 'content-type': 'application/x-tar' },
      body: new TextEncoder().encode('the context'),
      isBodyCut: false,
    },
  ]);
});

test('it marks a body the client cut off before its end', async () => {
  const ctx = await setupTest();

  const pulls = { count: 0 };

  // one chunk, then an error once the engine has started to read
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls.count += 1;

      if (pulls.count > 2) {
        controller.error(new Error('cut'));

        return;
      }

      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });

  await fetch('http://docker/v1.55/build', { unix: ctx.engine.socket, method: 'POST', body }).catch(
    () => null,
  );

  const seen = await waitFor(() => {
    invariant(ctx.engine.seen[0]);

    return ctx.engine.seen[0];
  });

  expect(seen.isBodyCut).toBeTrue();
});

test('it answers a build with the built image ID as a JSON line', async () => {
  const ctx = await setupTest();

  const response = await fetch('http://docker/v1.55/build', {
    unix: ctx.engine.socket,
    method: 'POST',
    body: 'ctx',
  });

  const answer: unknown = await response.text();

  expect(answer).toBe(
    `${JSON.stringify({ id: 'moby.image.id', aux: { ID: `sha256:${'e'.repeat(64)}` } })}\n`,
  );
});

test('it creates a container whose inspect carries the labels of its create body', async () => {
  const ctx = await setupTest();

  const created = await fetch('http://docker/v1.55/containers/create', {
    unix: ctx.engine.socket,
    method: 'POST',
    body: JSON.stringify({ Image: 'busybox', Labels: { owner: 'test' } }),
  });

  const createdBody: unknown = await created.json();

  const id = z.object({ Id: z.string() }).parse(createdBody).Id;

  const inspected = await fetch(`http://docker/v1.55/containers/${id.slice(0, 12)}/json`, {
    unix: ctx.engine.socket,
  });

  const answer: unknown = await inspected.json();

  expect(answer).toStrictEqual({ Id: id, Config: { Labels: { owner: 'test' } } });
});

test('it answers 404 for the inspect of a container it does not have', async () => {
  const ctx = await setupTest();

  const response = await fetch(`http://docker/v1.55/containers/${'c'.repeat(64)}/json`, {
    unix: ctx.engine.socket,
  });

  expect(response.status).toBe(404);
});

test('it streams the export bytes of a container it has', async () => {
  const ctx = await setupTest();

  await ctx.engine.addContainer({ id: 'a'.repeat(64), labels: {} });

  const response = await fetch(`http://docker/v1.55/containers/${'a'.repeat(64)}/export`, {
    unix: ctx.engine.socket,
  });

  const answer: unknown = await response.text();

  expect(answer).toBe('tar bytes');
});

test('it removes a container on a DELETE', async () => {
  const ctx = await setupTest();

  await ctx.engine.addContainer({ id: 'a'.repeat(64), labels: {} });

  const response = await fetch(`http://docker/v1.55/containers/${'a'.repeat(64)}?force=1&v=1`, {
    unix: ctx.engine.socket,
    method: 'DELETE',
  });

  expect(response.status).toBe(204);
  expect(ctx.engine.hasContainer('a'.repeat(64))).toBeFalse();
});

test('it keeps an image a pull names by its tag', async () => {
  const ctx = await setupTest();

  await fetch('http://docker/v1.55/images/create?fromImage=busybox&tag=1.37', {
    unix: ctx.engine.socket,
    method: 'POST',
  });

  expect(ctx.engine.hasImage('busybox:1.37')).toBeTrue();
});

test('it keeps an image a pull names by its digest', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  await fetch(`http://docker/v1.55/images/create?fromImage=busybox&tag=${digest}`, {
    unix: ctx.engine.socket,
    method: 'POST',
  });

  expect(ctx.engine.hasImage(`busybox@${digest}`)).toBeTrue();
});

test('it answers a pull with a JSON progress line', async () => {
  const ctx = await setupTest();

  const response = await fetch('http://docker/v1.55/images/create?fromImage=busybox&tag=1.37', {
    unix: ctx.engine.socket,
    method: 'POST',
  });

  const answer: unknown = await response.text();

  expect(answer).toBe(`${JSON.stringify({ status: 'Pulling from busybox' })}\n`);
});

test('it answers 404 for the inspect of an image it does not have', async () => {
  const ctx = await setupTest();

  const response = await fetch('http://docker/v1.55/images/busybox:1.37/json', {
    unix: ctx.engine.socket,
  });

  const answer: unknown = await response.json();

  expect(answer).toStrictEqual({ message: 'No such image: busybox:1.37' });
});

test('it answers the inspect of an image it has with the fields impd reads', async () => {
  const ctx = await setupTest();

  await ctx.engine.addImage('docker.io/library/busybox:1.37');

  const response = await fetch('http://docker/v1.55/images/docker.io/library/busybox:1.37/json', {
    unix: ctx.engine.socket,
  });

  const answer: unknown = await response.json();

  expect(answer).toStrictEqual({
    Id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/v) as unknown,
    RepoTags: ['busybox:1.37'],
    RepoDigests: [],
    Os: 'linux',
    Architecture: 'amd64',
    Config: {},
    Size: 0,
  });
});

test('it answers the inspect of an image with a pin that impd parses', async () => {
  const ctx = await setupTest();

  await ctx.engine.addImage('busybox:1.37');

  const response = await fetch('http://docker/v1.55/images/busybox:1.37/json', {
    unix: ctx.engine.socket,
  });

  const answer: unknown = await response.json();

  expect(PinInspectSchema.safeParse(answer).success).toBeTrue();
});

test.each([
  ['busybox', 'docker.io/library/busybox:latest'],
  ['busybox:latest', 'docker.io/library/busybox'],
  ['library/busybox:1.37', 'docker.io/library/busybox:1.37'],
  ['index.docker.io/library/busybox:1.37', 'busybox:1.37'],
  ['zgeoff/imp:1', 'docker.io/zgeoff/imp:1'],
])('it finds an image added as %s when asked for %s', async (added, asked) => {
  const ctx = await setupTest();

  await ctx.engine.addImage(added);

  const response = await fetch(`http://docker/v1.55/images/${asked}/json`, {
    unix: ctx.engine.socket,
  });

  expect(response.status).toBe(200);
});

test('it keeps an image of another registry apart from docker.io', async () => {
  const ctx = await setupTest();

  await ctx.engine.addImage('ghcr.io/zgeoff/imp:1');

  const response = await fetch('http://docker/v1.55/images/zgeoff/imp:1/json', {
    unix: ctx.engine.socket,
  });

  expect(response.status).toBe(404);
});

test.each([
  ['docker.io/library/busybox:1.37', ['busybox:1.37']],
  ['docker.io/zgeoff/imp:1', ['zgeoff/imp:1']],
  ['ghcr.io/zgeoff/imp:1', ['ghcr.io/zgeoff/imp:1']],
  ['localhost:5000/imp:1', ['localhost:5000/imp:1']],
])('it shows %s in RepoTags as %j', async (ref, repoTags) => {
  const ctx = await setupTest();

  await ctx.engine.addImage(ref);

  const response = await fetch(`http://docker/v1.55/images/${ref}/json`, {
    unix: ctx.engine.socket,
  });

  const body: unknown = await response.json();

  const answer = z.object({ RepoTags: z.array(z.string()) }).parse(body);

  expect(answer.RepoTags).toStrictEqual(repoTags);
});

test('it shows an image pulled by digest in RepoDigests and not in RepoTags', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;

  await ctx.engine.addImage(`busybox@${digest}`);

  const response = await fetch(`http://docker/v1.55/images/busybox@${digest}/json`, {
    unix: ctx.engine.socket,
  });

  const body: unknown = await response.json();

  const answer = z
    .object({ RepoTags: z.array(z.string()), RepoDigests: z.array(z.string()) })
    .parse(body);

  expect(answer.RepoTags).toStrictEqual([]);
  expect(answer.RepoDigests).toStrictEqual([`busybox@${digest}`]);
});

test('it gives an image added with no reference a docker.io one', async () => {
  const ctx = await setupTest();
  const image = await ctx.engine.addImage();

  expect(image.ref).toMatch(/^docker\.io\/library\/[a-z]{8}:latest$/v);
});

test('it lets the test answer a request ahead of its defaults', async () => {
  const ctx = await setupTest();

  ctx.engine.setAnswer((_request, seen) =>
    seen.target === '/_ping' ? new Response('down', { status: 500 }) : null,
  );

  const response = await fetch('http://docker/_ping', { unix: ctx.engine.socket });

  expect(response.status).toBe(500);
});

test('it answers with its defaults a request the test answer leaves', async () => {
  const ctx = await setupTest();

  ctx.engine.setAnswer(() => null);

  const response = await fetch('http://docker/_ping', { unix: ctx.engine.socket });
  const answer: unknown = await response.text();

  expect(answer).toBe('OK');
});

test('it answers 500 naming a call it does not model', async () => {
  const ctx = await setupTest();

  const response = await fetch('http://docker/v1.55/swarm/init', {
    unix: ctx.engine.socket,
    method: 'POST',
  });

  const answer: unknown = await response.json();

  expect(response.status).toBe(500);

  expect(answer).toStrictEqual({
    message: 'stub docker engine: POST /swarm/init is not modelled',
  });
});

test('it lists each call it does not model', async () => {
  const ctx = await setupTest();

  await fetch('http://docker/v1.55/swarm/init', { unix: ctx.engine.socket, method: 'POST' });

  await fetch('http://docker/v1.55/containers/abc/start', {
    unix: ctx.engine.socket,
    method: 'POST',
  });

  expect(ctx.engine.unexpected).toStrictEqual(['POST /swarm/init', 'POST /containers/abc/start']);
});

test('it answers a ping under an older API version prefix', async () => {
  const ctx = await setupTest();
  const response = await fetch('http://docker/v1.41/_ping', { unix: ctx.engine.socket });
  const answer: unknown = await response.text();

  expect(answer).toBe('OK');
});

test('it answers a create with 201, the new ID and no warnings', async () => {
  const ctx = await setupTest();

  const response = await fetch('http://docker/v1.55/containers/create', {
    unix: ctx.engine.socket,
    method: 'POST',
    body: JSON.stringify({ Image: 'busybox' }),
  });

  const answer: unknown = await response.json();

  expect(response.status).toBe(201);

  expect(answer).toStrictEqual({
    Id: expect.stringMatching(/^[0-9a-f]{64}$/v) as unknown,
    Warnings: [],
  });
});

test('it answers the inspect of a missing container with the engine error body', async () => {
  const ctx = await setupTest();

  const response = await fetch(`http://docker/v1.55/containers/${'c'.repeat(12)}/json`, {
    unix: ctx.engine.socket,
  });

  const answer: unknown = await response.json();

  expect(answer).toStrictEqual({ message: `No such container: ${'c'.repeat(12)}` });
});

test('it refuses the connection once stopped', async () => {
  const ctx = await setupTest();

  await ctx.engine.stop();

  expect(fetch('http://docker/_ping', { unix: ctx.engine.socket })).rejects.toThrow();
});

test('it stops a second time without an error', async () => {
  const ctx = await setupTest();

  await ctx.engine.stop();

  await expect(ctx.engine.stop()).toResolve();
});

test('it stops when the test that started it ends', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.dir, 'second');

  await mkdir(dir);

  const engine = startStubDockerEngine({ dir });

  // a ping the engine holds open, which only its stop ends
  engine.setAnswer(() => new Promise<Response>(() => {}));

  // settles, never rejects, so nothing waits on it unhandled
  const held = Promise.allSettled([fetch('http://docker/_ping', { unix: engine.socket })]);

  await waitFor(() => {
    expect(engine.seen).toHaveLength(1);
  });

  // registered after the engine's own release, so it runs after it
  onTestFinished(async () => {
    const [ping] = await held;

    expect(ping?.status).toBe('rejected');
  });
});
