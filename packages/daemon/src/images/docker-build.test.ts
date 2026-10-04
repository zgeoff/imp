import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQuery } from '../docker-proxy/router';
import { checkBuildQuery } from '../docker-proxy/rules';
import {
  DockerBuildError,
  readBuiltImageId,
  readDockerSocket,
  runDockerBuild,
} from './docker-build';

const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const dir = mkdtempSync(join(tmpdir(), 'imp-docker-build-'));
const socketPath = join(dir, 'engine.sock');
const tarPath = join(dir, 'context.tar');

interface Seen {
  readonly target: string;
  readonly contentType: string | null;
  readonly body: string;
}

const seen: Seen[] = [];
const engine: { answer: () => Response | Promise<Response> } = { answer: () => new Response() };

const server = Bun.serve({
  unix: socketPath,
  fetch: async (request) => {
    const url = new URL(request.url);

    seen.push({
      target: `${url.pathname}${url.search}`,
      contentType: request.headers.get('content-type'),
      body: await request.text(),
    });

    return engine.answer();
  },
});

writeFileSync(tarPath, 'the context');

beforeEach(() => {
  seen.length = 0;
});

afterAll(async () => {
  await server.stop(true);

  rmSync(dir, { recursive: true, force: true });
});

function buildLines(...messages: readonly unknown[]): string {
  return messages.map((message) => `${JSON.stringify(message)}\n`).join('');
}

function runBuild(signal = new AbortController().signal): Promise<string> {
  return runDockerBuild({
    dockerHost: `unix://${socketPath}`,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: 'sub/Df',
    signal,
  });
}

test('the image ID is the moby.image.id message, past the trace messages', async () => {
  const id = await readBuiltImageId([
    { id: 'moby.buildkit.trace', aux: 'CgQ=' },
    { id: 'moby.image.id', aux: { ID: IMAGE_ID } },
  ]);

  expect(id).toBe(IMAGE_ID);
});

test('an error message fails the build with its last 4000 characters', async () => {
  const long = `${'x'.repeat(5000)}exit code: 1`;

  const failure = await readBuiltImageId([{ error: long, errorDetail: { message: long } }]).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(DockerBuildError);
  expect(String(failure)).toEndWith('exit code: 1');
  expect(String(failure)).toHaveLength('DockerBuildError: docker build failed: '.length + 4000);
});

test('a stream with no image ID fails, but not as the client’s build', async () => {
  const failure = await readBuiltImageId([{ stream: 'done' }]).catch((error: unknown) => error);

  expect(failure).not.toBeInstanceOf(DockerBuildError);
  expect(String(failure)).toContain('no image ID');
});

test('impd sends the context as the body, with a query the proxy lets through', async () => {
  engine.answer = () =>
    new Response(
      buildLines(
        { id: 'moby.buildkit.trace', aux: 'CgQ=' },
        { id: 'moby.image.id', aux: { ID: IMAGE_ID } },
      ),
    );

  const id = await runBuild();

  const [request] = seen;

  expect(id).toBe(IMAGE_ID);

  const query = new URL(`http://docker${request?.target ?? ''}`).search.slice(1);

  expect(request?.body).toBe('the context');
  expect(request?.contentType).toBe('application/x-tar');
  expect(checkBuildQuery(parseQuery(query))).toEqual({ isOk: true });
});

// a quiet RUN step leaves the answer silent past Bun's 360 s limit
test('the build lifts the limit on a silent answer', async () => {
  engine.answer = () => new Response(buildLines({ id: 'moby.image.id', aux: { ID: IMAGE_ID } }));

  const sent = spyOn(globalThis, 'fetch');

  try {
    await runBuild();

    expect(sent.mock.calls.map(([, init = {}]): unknown => Reflect.get(init, 'timeout'))).toEqual([
      false,
    ]);
  } finally {
    sent.mockRestore();
  }
});

test('a message split across chunks is read whole', async () => {
  const lines = buildLines({ id: 'moby.image.id', aux: { ID: IMAGE_ID } });

  engine.answer = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(lines.slice(0, 10)));
          controller.enqueue(new TextEncoder().encode(lines.slice(10)));
          controller.close();
        },
      }),
    );

  const id = await runBuild();

  expect(id).toBe(IMAGE_ID);
});

// #173 turns #163's refusal-as-500 into the client's error, as impd's own
// checks of the same rules answer; a 403 not from the proxy stays impd's
test('a refusal and a context over the proxy’s limit are the client’s; other answers are impd’s', async () => {
  engine.answer = () => Response.json({ message: 'imp-docker-proxy: no' }, { status: 403 });

  const refused = await runBuild().catch((error: unknown) => error);

  expect(refused).toMatchObject({ code: 'BAD_REQUEST', message: 'imp-docker-proxy: no' });

  engine.answer = () => Response.json({ message: 'too large' }, { status: 413 });

  const tooLarge = await runBuild().catch((error: unknown) => error);

  expect(tooLarge).toBeInstanceOf(DockerBuildError);

  engine.answer = () => Response.json({ message: 'denied' }, { status: 403 });

  const denied = await runBuild().catch((error: unknown) => error);

  expect(denied).not.toBeInstanceOf(DockerBuildError);
  expect(denied).not.toHaveProperty('code');
  expect(String(denied)).toContain('answered 403: denied');

  engine.answer = () =>
    Response.json({ message: 'imp-docker-proxy: the engine call failed: x' }, { status: 502 });

  const failed = await runBuild().catch((error: unknown) => error);

  expect(failed).not.toHaveProperty('code');
  expect(String(failed)).toContain('answered 502');
});

test('an abort ends the request while the build runs', async () => {
  const controller = new AbortController();

  engine.answer = () =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(buildLines({ id: 'moby.buildkit.trace' })));
          controller.abort();
        },
      }),
    );

  const failure = await runBuild(controller.signal).catch((error: unknown) => error);

  expect(controller.signal.aborted).toBeTrue();
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(DockerBuildError);
});

test('a line that is not JSON, or too long, fails the build with a clear error', async () => {
  engine.answer = () => new Response('{"stream":"ok"}\n<html>proxy error</html>\n');

  const notJson = await runBuild().catch((error: unknown) => error);

  expect(String(notJson)).toContain('a line that is not JSON: <html>proxy error</html>');

  engine.answer = () => new Response('x'.repeat(9 * 1024 ** 2));

  const tooLong = await runBuild().catch((error: unknown) => error);

  expect(String(tooLong)).toContain('a line longer than');
});

test('builds go to the unix socket DOCKER_HOST names, and only to one', () => {
  expect(readDockerSocket('unix:///run/imp-docker/docker.sock')).toBe(
    '/run/imp-docker/docker.sock',
  );

  expect(readDockerSocket(null)).toBe('/var/run/docker.sock');
  expect(() => readDockerSocket('tcp://10.0.0.1:2375')).toThrow('only through a unix socket');
});
