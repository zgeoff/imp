import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { parseQuery } from '../docker-proxy/router';
import { checkBuildQuery } from '../docker-proxy/rules';
import { startStubDockerEngine } from '../test-utils/start-stub-docker-engine';
import { startStubSilentBuildEngine } from '../test-utils/start-stub-silent-build-engine';
import {
  DockerBuildError,
  readBuiltImageId,
  readDockerSocket,
  runDockerBuild,
} from './docker-build';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'docker-build-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const engine = startStubDockerEngine({ dir });

  stack.defer(() => engine.stop());

  // a release deferred here runs before the engine stops and the dir goes
  return { stack, dir, engine };
}

test('#readBuiltImageId reads the image ID past the trace messages', async () => {
  const id = await readBuiltImageId([
    { id: 'moby.buildkit.trace', aux: 'CgQ=' },
    { id: 'moby.image.id', aux: { ID: `sha256:${'c'.repeat(64)}` } },
  ]);

  expect(id).toBe(`sha256:${'c'.repeat(64)}`);
});

test('#readBuiltImageId fails the client build with the last 4000 characters of its error', () => {
  const long = `${'x'.repeat(5000)}exit code: 1`;

  expect(
    readBuiltImageId([{ error: long, errorDetail: { message: long } }]),
  ).rejects.toThrowWithMessage(DockerBuildError, `docker build failed: ${long.slice(-4000)}`);
});

test('#readBuiltImageId fails the client build with an error that has no detail', () => {
  expect(readBuiltImageId([{ error: 'exit code: 2' }])).rejects.toThrowWithMessage(
    DockerBuildError,
    'docker build failed: exit code: 2',
  );
});

test('#readBuiltImageId fails a stream with no image ID as impd error, not the client build', () => {
  const reading = readBuiltImageId([{ stream: 'done' }]);

  expect(reading).rejects.toThrowWithMessage(Error, 'docker build: the engine sent no image ID');
  expect(reading).rejects.not.toBeInstanceOf(DockerBuildError);
});

test('#runDockerBuild sends the context as a tar body, with a query the proxy lets through', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  await runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: 'sub/Df',
    signal: new AbortController().signal,
  });

  const [build] = ctx.engine.seen;

  invariant(build);

  const query = parseQuery(build.target.slice(build.target.indexOf('?') + 1));

  expect(checkBuildQuery(query)).toStrictEqual({ isOk: true });
  expect(new URL(`http://docker${build.target}`).searchParams.get('dockerfile')).toBe('sub/Df');
  expect(build.headers['content-type']).toBe('application/x-tar');
  expect(new TextDecoder().decode(build.body)).toBe('the context');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#runDockerBuild returns the image ID the engine built', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  ctx.engine.setAnswer(
    () =>
      new Response(
        `${JSON.stringify({ id: 'moby.image.id', aux: { ID: `sha256:${'c'.repeat(64)}` } })}\n`,
      ),
  );

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: new AbortController().signal,
  });

  expect(building).resolves.toBe(`sha256:${'c'.repeat(64)}`);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#runDockerBuild reads a message split across chunks whole', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  ctx.engine.setAnswer(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const line = `${JSON.stringify({ id: 'moby.image.id', aux: { ID: `sha256:${'c'.repeat(64)}` } })}\n`;

            controller.enqueue(new TextEncoder().encode(line.slice(0, 10)));
            controller.enqueue(new TextEncoder().encode(line.slice(10)));
            controller.close();
          },
        }),
      ),
  );

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: new AbortController().signal,
  });

  expect(building).resolves.toBe(`sha256:${'c'.repeat(64)}`);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// #173 turns #163's refusal-as-500 into the client's error, as impd's own
// checks of the same rules answer

test('#runDockerBuild fails with the proxy refusal as the client bad request', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  ctx.engine.setAnswer(() => Response.json({ message: 'imp-docker-proxy: no' }, { status: 403 }));

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: new AbortController().signal,
  });

  expect(building).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'imp-docker-proxy: no' });
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#runDockerBuild fails a context over the proxy limit as the client build', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  ctx.engine.setAnswer(() => Response.json({ message: 'too large' }, { status: 413 }));

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: new AbortController().signal,
  });

  expect(building).rejects.toThrowWithMessage(DockerBuildError, 'too large');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#runDockerBuild fails a 403 the proxy did not write as impd error', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  ctx.engine.setAnswer(() => Response.json({ message: 'denied' }, { status: 403 }));

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: new AbortController().signal,
  });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'docker build: the engine answered 403: denied',
  );

  expect(building).rejects.not.toHaveProperty('code');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#runDockerBuild fails the proxy engine failure as impd error', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  ctx.engine.setAnswer(() =>
    Response.json({ message: 'imp-docker-proxy: the engine call failed: x' }, { status: 502 }),
  );

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: new AbortController().signal,
  });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'docker build: the engine answered 502: imp-docker-proxy: the engine call failed: x',
  );

  expect(building).rejects.not.toHaveProperty('code');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#runDockerBuild fails an answer that is not JSON with its text', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  ctx.engine.setAnswer(() => new Response('  boom\n', { status: 500 }));

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: new AbortController().signal,
  });

  expect(building).rejects.toThrowWithMessage(Error, 'docker build: the engine answered 500: boom');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#runDockerBuild fails a line that is not JSON and names it', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  ctx.engine.setAnswer(() => new Response('{"stream":"ok"}\n<html>proxy error</html>\n'));

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: new AbortController().signal,
  });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'docker build: the engine sent a line that is not JSON: <html>proxy error</html>',
  );

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#runDockerBuild fails a line longer than 8 MiB', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  ctx.engine.setAnswer(() => new Response('x'.repeat(9 * 1024 ** 2)));

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: new AbortController().signal,
  });

  expect(building).rejects.toThrowWithMessage(
    Error,
    'docker build: the engine sent a line longer than 8388608 characters',
  );

  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#runDockerBuild ends the request when its signal aborts while the build runs', async () => {
  const ctx = await setupTest();

  const tarPath = join(ctx.dir, 'context.tar');

  await Bun.write(tarPath, 'the context');

  const controller = new AbortController();

  ctx.engine.setAnswer(
    () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(`${JSON.stringify({ id: 'moby.buildkit.trace' })}\n`),
            );

            controller.abort();
          },
        }),
      ),
  );

  const building = runDockerBuild({
    dockerHost: ctx.engine.dockerHost,
    tarPath,
    tag: 'imp/x:latest',
    dockerfile: undefined,
    signal: controller.signal,
  });

  await building.catch(() => {});

  expect(controller.signal.aborted).toBeTrue();
  expect(building).rejects.toMatchObject({ name: 'AbortError', code: 20 });
  expect(building).rejects.not.toBeInstanceOf(DockerBuildError);
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

// Bun reads its fetch idle limit (360 s by default) only at startup, so a
// child Bun runs with 1 s; its unprotected fetch is the control that the
// limit expires, after about 8 s on Bun 1.4.2
test('#runDockerBuild gets the image of a build silent past the idle limit, which a client still cancels', async () => {
  const ctx = await setupTest();

  const ended = Promise.withResolvers<void>();

  const control = await startStubSilentBuildEngine({
    socketPath: join(ctx.dir, 'control-engine.sock'),
    imageId: `sha256:${'d'.repeat(64)}`,
    holdUntil: () => ended.promise,
  });

  ctx.stack.defer(() => control.stop());

  // silent until the control's connection is gone, past the limit
  const build = await startStubSilentBuildEngine({
    socketPath: join(ctx.dir, 'build-engine.sock'),
    imageId: `sha256:${'c'.repeat(64)}`,
    holdUntil: () => control.closed,
  });

  ctx.stack.defer(() => build.stop());

  const cancelled = await startStubSilentBuildEngine({
    socketPath: join(ctx.dir, 'cancel-engine.sock'),
    imageId: `sha256:${'e'.repeat(64)}`,
    holdUntil: () => ended.promise,
  });

  ctx.stack.defer(() => cancelled.stop());

  // the held answers end before the engines stop
  ctx.stack.defer(() => {
    ended.resolve();
  });

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../test-utils/run-idle-limited-docker-build.ts'),
      JSON.stringify({
        dir: ctx.dir,
        buildEngine: join(ctx.dir, 'build-engine.sock'),
        cancelEngine: join(ctx.dir, 'cancel-engine.sock'),
        controlEngine: join(ctx.dir, 'control-engine.sock'),
      }),
    ],
    {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );

  // the child goes first, before the engines it calls
  ctx.stack.defer(() => {
    child.kill();
  });

  // the control starts once both builds are silent, so it goes quiet last
  await Promise.all([build.started, cancelled.started]);
  await child.stdin.write('control\n');
  await child.stdin.flush();

  await control.closed;

  await child.stdin.write('cancel\n');
  await child.stdin.flush();

  await cancelled.closed;

  const output = await new Response(child.stdout).text();

  const lines: unknown[] = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  const exitCode = await child.exited;

  expect(exitCode).toBe(0);

  expect(lines).toIncludeSameMembers([
    { kind: 'control', isOk: false, error: { name: 'TimeoutError', code: 23 } },
    { kind: 'build', isOk: true, id: `sha256:${'c'.repeat(64)}` },
    { kind: 'cancel', isOk: false, error: { name: 'AbortError', code: 20 } },
  ]);
}, 30_000);

test.each([
  ['unix:///run/imp-docker/docker.sock', '/run/imp-docker/docker.sock'],
  [null, '/var/run/docker.sock'],
])('#readDockerSocket reads %p as the socket %s', (dockerHost, socket) => {
  expect(readDockerSocket(dockerHost)).toBe(socket);
});

test('#readDockerSocket refuses a DOCKER_HOST that is not a unix socket', () => {
  expect(() => readDockerSocket('tcp://10.0.0.1:2375')).toThrowWithMessage(
    Error,
    'DOCKER_HOST is tcp://10.0.0.1:2375; impd builds images only through a unix socket, unix:///<path>',
  );
});
