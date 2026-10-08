import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { startStubSilentBuildEngine } from './start-stub-silent-build-engine';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'stub-engine-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  return {
    socketPath: join(dir, 'engine.sock'),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it answers a build with a trace, then sends the image id once the hold settles', async () => {
  await using ctx = await setupTest();

  const hold = Promise.withResolvers<undefined>();

  // declared after ctx, so the engine closes before ctx's dir goes
  await using held = new AsyncDisposableStack();

  const engine = await startStubSilentBuildEngine({
    socketPath: ctx.socketPath,
    imageId: 'sha256:abc',
    holdUntil: () => hold.promise,
  });

  held.use(engine);

  const client = connect(ctx.socketPath);

  onTestFinished(() => client.destroy());

  const received: string[] = [];

  const ended = new Promise<void>((resolve) => {
    client.on('end', resolve);
  });

  client.on('data', (chunk: Buffer) => {
    received.push(chunk.toString());
  });

  client.write('POST /build HTTP/1.1\r\nHost: docker\r\n\r\n');

  await waitFor(() => {
    expect(received.join('')).toInclude('moby.buildkit.trace');
  });

  const beforeHold = received.join('');

  hold.resolve(undefined);

  await ended;

  expect({ beforeHold, after: received.join('').slice(beforeHold.length) }).toStrictEqual({
    beforeHold: [
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
      '2a\r\n{"id":"moby.buildkit.trace","aux":"CgQ="}\n\r\n',
    ].join(''),
    after: '31\r\n{"id":"moby.image.id","aux":{"ID":"sha256:abc"}}\n\r\n0\r\n\r\n',
  });
});

test('it closes a connection it still holds when disposed', async () => {
  await using ctx = await setupTest();

  const held = Promise.withResolvers<undefined>();

  await using engine = await startStubSilentBuildEngine({
    socketPath: ctx.socketPath,
    imageId: 'sha256:abc',
    holdUntil: () => {
      held.resolve(undefined);

      return new Promise<void>(() => {});
    },
  });

  const client = connect(ctx.socketPath);

  onTestFinished(() => client.destroy());

  const closed = new Promise<void>((resolve) => {
    client.on('close', () => {
      resolve();
    });
  });

  client.on('error', () => {});

  // reads what the engine sends, so the end and the close reach the client
  client.resume();
  client.write('POST /build HTTP/1.1\r\nHost: docker\r\n\r\n');

  // the engine has answered and holds the connection
  await held.promise;

  await engine[Symbol.asyncDispose]();

  await expect(closed).toResolve();
});

test('it settles a second dispose once the engine is closed', async () => {
  await using ctx = await setupTest();

  await using engine = await startStubSilentBuildEngine({
    socketPath: ctx.socketPath,
    imageId: 'sha256:abc',
    holdUntil: () => new Promise<void>(() => {}),
  });

  await engine[Symbol.asyncDispose]();

  await expect(engine[Symbol.asyncDispose]()).toResolve();
});
