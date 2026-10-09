import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendPing } from '../agent-client/agent-requests';
import { openAttachStream } from '../agent-client/exec-stream';
import { FRAME_TYPES, encodeJsonFrame } from '../agent-client/frame-codec';
import { startStubAttachAgent } from './start-stub-attach-agent';

// a temp dir for the agent's socket, and `stack`, whose releases (the
// agent's and the streams') run before the dir goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-attach-agent-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir, stack };
}

test('it reports its boot and a 0.15.0 agent in its ping', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubAttachAgent(path, { bootId: 'boot-a', stack: ctx.stack });

  const ping = await sendPing(path);

  expect(ping).toStrictEqual({ ok: true, version: '0.15.0', boot_id: 'boot-a' });
});

test('it answers a session request with the first reply, and keeps a stream open', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubAttachAgent(path, {
    bootId: 'boot-a',
    replies: [{ frame: encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }), isEnd: false }],
    stack: ctx.stack,
  });

  const stream = await openAttachStream(path, { session: 'main' });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(stream.pid).toBe(9);
});

test('it answers the next session request with the next reply, and ends its connection', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubAttachAgent(path, {
    bootId: 'boot-a',
    replies: [
      { frame: encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }), isEnd: false },
      {
        frame: encodeJsonFrame(FRAME_TYPES.response, {
          error: { code: 'NO_SESSION', message: 'no session "main"' },
        }),
        isEnd: true,
      },
    ],
    stack: ctx.stack,
  });

  const first = await openAttachStream(path, { session: 'main' });

  ctx.stack.defer(() => {
    first.close();
  });

  expect(openAttachStream(path, { session: 'main' })).rejects.toMatchObject({
    code: 'NO_SESSION',
  });
});

test('it ends the connection of a session request past its last reply', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubAttachAgent(path, { bootId: 'boot-a', stack: ctx.stack });

  expect(openAttachStream(path, { session: 'main' })).rejects.toThrow();
});

test('it lists the ops of the requests it got', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubAttachAgent(path, { bootId: 'boot-a', stack: ctx.stack });

  await sendPing(path);

  expect(openAttachStream(path, { session: 'main' })).rejects.toThrow();
  expect(agent.readOps()).toStrictEqual(['ping', 'session.attach']);
});

test('it stops listening once its stack is released', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const stack = new AsyncDisposableStack();

  await startStubAttachAgent(path, { bootId: 'boot-a', stack });

  await stack.disposeAsync();

  expect(sendPing(path)).rejects.toThrow();
});
