import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChildTests } from '@imp/test-utils/run-child-tests';
import { waitFor } from '@imp/test-utils/wait-for';
import { startStubDockerEngine } from './start-stub-docker-engine';

// a directory for the engine's socket
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-docker-engine-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir, socketPath: join(dir, 'docker.sock') };
}

test('it answers a build with a trace line, then the image ID', async () => {
  const ctx = await setupTest();

  startStubDockerEngine({ socketPath: ctx.socketPath, imageId: `sha256:${'b'.repeat(64)}` });

  const response = await fetch('http://docker/build?t=imp%2Fweb%3Alatest', {
    method: 'POST',
    body: 'tar',
    unix: ctx.socketPath,
  });

  const text = await response.text();

  expect(text).toBe(
    `{"id":"moby.buildkit.trace","aux":"CgQ="}\n{"id":"moby.image.id","aux":{"ID":"sha256:${'b'.repeat(64)}"}}\n`,
  );
});

test('it keeps the context of each build', async () => {
  const ctx = await setupTest();

  const engine = startStubDockerEngine({
    socketPath: ctx.socketPath,
    imageId: `sha256:${'b'.repeat(64)}`,
  });

  const response = await fetch('http://docker/build', {
    method: 'POST',
    body: 'tar',
    unix: ctx.socketPath,
  });

  await response.text();

  expect(engine.contexts).toStrictEqual([new TextEncoder().encode('tar')]);
});

test('it ends a build with its error in place of the image', async () => {
  const ctx = await setupTest();

  startStubDockerEngine({
    socketPath: ctx.socketPath,
    imageId: `sha256:${'b'.repeat(64)}`,
    failure: 'no FROM',
  });

  const response = await fetch('http://docker/build', {
    method: 'POST',
    body: 'tar',
    unix: ctx.socketPath,
  });

  const text = await response.text();

  expect(text).toBe(
    '{"id":"moby.buildkit.trace","aux":"CgQ="}\n{"errorDetail":{"message":"no FROM"},"error":"no FROM"}\n',
  );
});

test('it holds a build after its trace line until holdUntil settles', async () => {
  const ctx = await setupTest();

  const release = Promise.withResolvers<void>();

  startStubDockerEngine({
    socketPath: ctx.socketPath,
    imageId: `sha256:${'b'.repeat(64)}`,
    holdUntil: () => release.promise,
  });

  const response = await fetch('http://docker/build', {
    method: 'POST',
    body: 'tar',
    unix: ctx.socketPath,
  });

  const lines: string[] = [];

  const reading = (async () => {
    const body: AsyncIterable<Uint8Array> = response.body ?? new ReadableStream<Uint8Array>();

    for await (const chunk of body) {
      lines.push(new TextDecoder().decode(chunk));
    }
  })();

  await waitFor(() => {
    expect(lines).toStrictEqual(['{"id":"moby.buildkit.trace","aux":"CgQ="}\n']);
  });

  const statusWhileHeld = Bun.peek.status(reading);

  release.resolve();

  await reading;

  expect(statusWhileHeld).toBe('pending');

  expect(lines.join('')).toEndWith(
    `{"id":"moby.image.id","aux":{"ID":"sha256:${'b'.repeat(64)}"}}\n`,
  );
});

test('it records that the caller of a held build went', async () => {
  const ctx = await setupTest();

  const engine = startStubDockerEngine({
    socketPath: ctx.socketPath,
    imageId: `sha256:${'b'.repeat(64)}`,
    holdUntil: () => new Promise<void>(() => {}),
  });

  const caller = new AbortController();

  const response = await fetch('http://docker/build', {
    method: 'POST',
    body: 'tar',
    unix: ctx.socketPath,
    signal: caller.signal,
  });

  const signalBeforeAbort = engine.signals.at(0)?.aborted;

  caller.abort();

  await response.text().catch(() => null);

  await waitFor(() => {
    expect(engine.signals.at(0)?.aborted).toBeTrue();
  });

  expect(signalBeforeAbort).toBeFalse();
});

test('it answers any other call 404', async () => {
  const ctx = await setupTest();

  startStubDockerEngine({ socketPath: ctx.socketPath, imageId: `sha256:${'b'.repeat(64)}` });

  const response = await fetch('http://docker/_ping', { unix: ctx.socketPath });

  expect(response.status).toBe(404);
});

test('it stops when the test finishes', async () => {
  const ctx = await setupTest();

  const run = runChildTests(
    ctx.dir,
    [
      "import { expect, test } from 'bun:test';",
      `import { startStubDockerEngine } from ${JSON.stringify(join(import.meta.dir, 'start-stub-docker-engine.ts'))};`,
      `const socketPath = ${JSON.stringify(ctx.socketPath)};`,
      "test('it starts', () => { startStubDockerEngine({ socketPath, imageId: 'sha256:x' }); });",
      "test('it finds it stopped', () => {",
      "  expect(fetch('http://docker/_ping', { unix: socketPath })).rejects.toThrow();",
      '});',
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});
