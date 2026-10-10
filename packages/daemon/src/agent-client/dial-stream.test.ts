import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { startStubAgent } from '../test-utils/start-stub-agent';
import { startStubDialAgent } from '../test-utils/start-stub-dial-agent';
import { openDialStream } from './dial-stream';
import { FRAME_TYPES, decodeJsonPayload, encodeFrame, encodeJsonFrame } from './frame-codec';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-dial-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { vsockPath: join(dir, 'vsock.sock') };
}

test('it asks the agent to dial the target', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
  });

  const stream = await openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:8080' });

  stream.close();

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'dial',
    network: 'tcp',
    address: '127.0.0.1:8080',
  });
});

test('it relays both ways, with a half-close each way', async () => {
  const ctx = setupTest();

  await startStubDialAgent(ctx.vsockPath, (asked) => `got ${asked}`);

  const stream = await openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:8080' });

  stream.write(new TextEncoder().encode('hello'));

  await stream.drained();

  stream.end();

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'data', data: new TextEncoder().encode('got hello') },
    { type: 'eof' },
  ]);
});

test('it rejects with DIAL_FAILED when the agent cannot connect', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'DIAL_FAILED', message: 'dial tcp 127.0.0.1:8080: connection refused' },
      }),
    );
  });

  expect(
    openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:8080' }),
  ).rejects.toMatchObject({
    code: 'DIAL_FAILED',
    detail: 'dial tcp 127.0.0.1:8080: connection refused',
  });
});

test('it rejects with AGENT_OUTDATED for an agent from before dial', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op dial' },
      }),
    );
  });

  expect(
    openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:8080' }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('it rejects when the agent closes the connection before it answers', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end();
  });

  expect(
    openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:8080' }),
  ).rejects.toThrowWithMessage(Error, 'agent closed the dial connection before it answered');
});

test('it rejects when the agent sends output before it answers', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('early')));
  });

  expect(
    openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:8080' }),
  ).rejects.toThrowWithMessage(Error, 'agent closed the dial connection before it answered');
});

test('it rejects when the agent does not answer within the answer timeout', async () => {
  const ctx = setupTest();

  // an agent that never answers, so the deadline alone decides
  await startStubAgent(ctx.vsockPath, () => {});

  expect(
    openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:8080' }, 1),
  ).rejects.toThrowWithMessage(Error, 'agent did not answer within 1 ms');
});

test('it ends the events without an eof when the target resets', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
    socket.end(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('partial')));
  });

  const stream = await openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:8080' });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'data', data: new TextEncoder().encode('partial') }]);
});
