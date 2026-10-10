import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentConnection } from '../agent-client/agent-connection';
import { FRAME_TYPES } from '../agent-client/frame-codec';
import { startStubDialAgent } from './start-stub-dial-agent';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-dial-agent-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { vsockPath: join(dir, 'vsock.sock') };
}

test('it answers the request with an ok response', async () => {
  const ctx = setupTest();

  await startStubDialAgent(ctx.vsockPath, (asked) => `got ${asked}`);

  const connection = await openAgentConnection(ctx.vsockPath);

  onTestFinished(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, {
    op: 'dial',
    network: 'tcp',
    address: '127.0.0.1:8080',
  });

  const frame = await connection.next();

  expect(frame).toStrictEqual({
    type: FRAME_TYPES.response,
    payload: new TextEncoder().encode('{"ok":true}'),
  });
});

test('it sends the answer to every stdin byte, then STDOUT_EOF, and ends the connection on stdin EOF', async () => {
  const ctx = setupTest();

  await startStubDialAgent(ctx.vsockPath, (asked) => `got ${asked}`);

  const connection = await openAgentConnection(ctx.vsockPath);

  onTestFinished(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, {
    op: 'dial',
    network: 'tcp',
    address: '127.0.0.1:8080',
  });

  connection.send(FRAME_TYPES.stdin, new TextEncoder().encode('hel'));
  connection.send(FRAME_TYPES.stdin, new TextEncoder().encode('lo'));
  connection.send(FRAME_TYPES.stdinEof);

  const frames = [
    await connection.next(),
    await connection.next(),
    await connection.next(),
    await connection.next(),
  ];

  expect(frames).toStrictEqual([
    { type: FRAME_TYPES.response, payload: new TextEncoder().encode('{"ok":true}') },
    { type: FRAME_TYPES.stdout, payload: new TextEncoder().encode('got hello') },
    { type: FRAME_TYPES.stdoutEof, payload: new Uint8Array() },
    null,
  ]);
});
