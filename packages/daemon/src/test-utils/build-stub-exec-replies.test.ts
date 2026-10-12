import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import {
  FRAME_TYPES,
  createFrameDecoder,
  encodeFrame,
  encodeJsonFrame,
} from '../agent-client/frame-codec';
import type { AgentFrame } from '../agent-client/frame-codec';
import { buildStubExecReplies } from './build-stub-exec-replies';
import { startStubAgent } from './start-stub-agent';

// a temp dir that holds the agent's socket
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-exec-replies-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir, socket: join(dir, 'v.sock') };
}

test('it answers the request with the started frames, and nothing more before stdin ends', async () => {
  const ctx = await setupTest();

  const exec = buildStubExecReplies({
    started: [
      encodeJsonFrame(FRAME_TYPES.started, { pid: 7 }),
      encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('out')),
    ],
    exited: [encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 })],
  });

  await startStubAgent(ctx.socket, exec);

  const client = createConnection(ctx.socket);

  onTestFinished(() => {
    client.destroy();
  });

  const decoder = createFrameDecoder();
  const replies: AgentFrame[] = [];
  const answered = Promise.withResolvers<void>();

  client.on('data', (chunk: Buffer) => {
    if (chunk.toString().startsWith('OK ')) {
      answered.resolve();

      return;
    }

    replies.push(...decoder.push(chunk));
  });

  client.write('CONNECT 1024\n');

  await answered.promise;

  client.write(encodeJsonFrame(FRAME_TYPES.request, { op: 'exec', argv: ['cat'] }));
  client.write(encodeFrame(FRAME_TYPES.stdin, new TextEncoder().encode('typed')));

  await waitFor(() => {
    expect(replies).toHaveLength(2);
  });

  expect(replies.map((frame) => frame.type)).toStrictEqual([
    FRAME_TYPES.started,
    FRAME_TYPES.stdout,
  ]);
});

test('it passes each stdin payload on, then answers the end of stdin with the exited frames', async () => {
  const ctx = await setupTest();

  const onStdin = mock<(payload: Uint8Array) => void>();
  const onStdinEnd = mock<() => void>();

  await startStubAgent(
    ctx.socket,
    buildStubExecReplies({
      started: [encodeJsonFrame(FRAME_TYPES.started, { pid: 7 })],
      exited: [encodeJsonFrame(FRAME_TYPES.exit, { code: 3, signal: 0 })],
      onStdin,
      onStdinEnd,
    }),
  );

  const client = createConnection(ctx.socket);

  onTestFinished(() => {
    client.destroy();
  });

  const decoder = createFrameDecoder();
  const replies: AgentFrame[] = [];
  const answered = Promise.withResolvers<void>();

  client.on('data', (chunk: Buffer) => {
    if (chunk.toString().startsWith('OK ')) {
      answered.resolve();

      return;
    }

    replies.push(...decoder.push(chunk));
  });

  client.write('CONNECT 1024\n');

  await answered.promise;

  client.write(encodeJsonFrame(FRAME_TYPES.request, { op: 'exec', argv: ['cat'] }));
  client.write(encodeFrame(FRAME_TYPES.stdin, new TextEncoder().encode('one')));
  client.write(encodeFrame(FRAME_TYPES.resize, new Uint8Array([0, 80, 0, 24])));
  client.write(encodeFrame(FRAME_TYPES.stdin, new TextEncoder().encode('two')));
  client.write(encodeFrame(FRAME_TYPES.stdinEof, new Uint8Array()));

  await waitFor(() => {
    expect(replies).toHaveLength(2);
  });

  expect(onStdin.mock.calls.map(([payload]) => new TextDecoder().decode(payload))).toStrictEqual([
    'one',
    'two',
  ]);

  expect(onStdinEnd).toHaveBeenCalledOnce();

  expect(replies).toStrictEqual([
    { type: FRAME_TYPES.started, payload: Buffer.from('{"pid":7}') },
    { type: FRAME_TYPES.exit, payload: Buffer.from('{"code":3,"signal":0}') },
  ]);
});
