import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { startStubSilentBuildEngine } from './start-stub-silent-build-engine';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-engine-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir, socketPath: join(dir, 'engine.sock') };
}

test('it answers a build with a trace, then sends the image id once the hold settles', async () => {
  const ctx = await setupTest();

  const hold = Promise.withResolvers<undefined>();

  await startStubSilentBuildEngine({
    socketPath: ctx.socketPath,
    imageId: 'sha256:abc',
    holdUntil: () => hold.promise,
  });

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

  expect(beforeHold).toBe(
    [
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
      '2a\r\n{"id":"moby.buildkit.trace","aux":"CgQ="}\n\r\n',
    ].join(''),
  );

  expect(received.join('').slice(beforeHold.length)).toBe(
    '31\r\n{"id":"moby.image.id","aux":{"ID":"sha256:abc"}}\n\r\n0\r\n\r\n',
  );
});

test('it settles closed once a client drops its connection', async () => {
  const ctx = await setupTest();

  const engine = await startStubSilentBuildEngine({
    socketPath: ctx.socketPath,
    imageId: 'sha256:abc',
    holdUntil: () => new Promise<void>(() => {}),
  });

  const client = connect(ctx.socketPath);

  onTestFinished(() => client.destroy());

  client.on('error', () => {});
  client.write('POST /build HTTP/1.1\r\nHost: docker\r\n\r\n');
  client.destroy();

  await expect(engine.closed).toResolve();
});

test('it closes a connection it still holds when stopped', async () => {
  const ctx = await setupTest();

  const held = Promise.withResolvers<undefined>();

  const engine = await startStubSilentBuildEngine({
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

  await engine.stop();

  await expect(closed).toResolve();
});

test('it settles a second stop once the engine is closed', async () => {
  const ctx = await setupTest();

  const engine = await startStubSilentBuildEngine({
    socketPath: ctx.socketPath,
    imageId: 'sha256:abc',
    holdUntil: () => new Promise<void>(() => {}),
  });

  await engine.stop();

  await expect(engine.stop()).toResolve();
});

test('it settles started once a client sends a build', async () => {
  const ctx = await setupTest();

  const engine = await startStubSilentBuildEngine({
    socketPath: ctx.socketPath,
    imageId: 'sha256:abc',
    holdUntil: () => new Promise<void>(() => {}),
  });

  const client = connect(ctx.socketPath);

  onTestFinished(() => client.destroy());

  client.on('error', () => {});
  client.resume();
  client.write('POST /build HTTP/1.1\r\nHost: docker\r\n\r\n');

  await expect(engine.started).toResolve();
});

test('it leaves started unsettled for a connection that sends nothing', async () => {
  const ctx = await setupTest();

  const engine = await startStubSilentBuildEngine({
    socketPath: ctx.socketPath,
    imageId: 'sha256:abc',
    holdUntil: () => new Promise<void>(() => {}),
  });

  const client = connect(ctx.socketPath);

  onTestFinished(() => client.destroy());

  client.on('error', () => {});

  client.on('connect', () => {
    client.end();
  });

  // the engine has seen the connection come and go
  await engine.closed;

  // a settled started wins the race, being first
  const first = await Promise.race([engine.started, Promise.resolve('pending')]);

  expect(first).toBe('pending');
});

test('it stops when the test that started it ends, closing a connection it holds', async () => {
  const ctx = await setupTest();

  const engine = await startStubSilentBuildEngine({
    socketPath: ctx.socketPath,
    imageId: 'sha256:abc',
    holdUntil: () => new Promise<void>(() => {}),
  });

  const client = connect(ctx.socketPath);
  const state = { isClosed: false };

  client.on('error', () => {});

  client.on('close', () => {
    state.isClosed = true;
  });

  client.resume();
  client.write('POST /build HTTP/1.1\r\nHost: docker\r\n\r\n');

  await engine.started;

  // registered after the engine's own stop, so it runs once that has
  onTestFinished(async () => {
    await waitFor(() => {
      expect(state.isClosed).toBeTrue();
    });
  });

  // the client goes last, so the check above sees only the engine's close
  onTestFinished(() => client.destroy());
});
