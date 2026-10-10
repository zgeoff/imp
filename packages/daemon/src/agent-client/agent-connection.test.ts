import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubAgent } from '../test-utils/start-stub-agent';
import { openAgentConnection } from './agent-connection';
import { FRAME_TYPES, encodeJsonFrame } from './frame-codec';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vsock-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { vsockPath: join(dir, 'vsock.sock') };
}

test('it hands over the frames the agent sends after its OK', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
  });

  const connection = await openAgentConnection(ctx.vsockPath);

  onTestFinished(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, { op: 'ping' });

  const frame = await connection.next();

  expect(frame).toStrictEqual({
    type: FRAME_TYPES.response,
    payload: new TextEncoder().encode('{"ok":true}'),
  });
});

test('it rejects a handshake that Firecracker refuses', async () => {
  const ctx = setupTest();

  // a host side that answers the CONNECT with a line other than OK
  const server = createServer((socket) => {
    socket.end('FAILURE\n');
  });

  await new Promise<void>((resolve) => {
    server.listen(ctx.vsockPath, resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  expect(openAgentConnection(ctx.vsockPath)).rejects.toThrowWithMessage(
    Error,
    'vsock handshake refused: "FAILURE"',
  );
});

test('it rejects when the socket closes during the handshake', async () => {
  const ctx = setupTest();

  const server = createServer((socket) => {
    socket.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(ctx.vsockPath, resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  expect(openAgentConnection(ctx.vsockPath)).rejects.toThrowWithMessage(
    Error,
    'vsock closed during the handshake',
  );
});

test('it rejects when the handshake gets no answer within the timeout', async () => {
  const ctx = setupTest();

  // a socket that takes the CONNECT and never answers, so the deadline alone decides
  const server = createServer(() => {});

  await new Promise<void>((resolve) => {
    server.listen(ctx.vsockPath, resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  expect(openAgentConnection(ctx.vsockPath, 1)).rejects.toThrowWithMessage(
    Error,
    'vsock handshake timed out after 1 ms',
  );
});

test('it rejects a vsock path that is not a socket', () => {
  const ctx = setupTest();

  writeFileSync(ctx.vsockPath, '');

  expect(openAgentConnection(ctx.vsockPath)).rejects.toThrowWithMessage(
    Error,
    `${ctx.vsockPath} is not a socket`,
  );
});
