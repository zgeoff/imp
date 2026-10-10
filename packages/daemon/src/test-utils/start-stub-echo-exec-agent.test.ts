import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentConnection } from '../agent-client/agent-connection';
import { FRAME_TYPES } from '../agent-client/frame-codec';
import { startStubEchoExecAgent } from './start-stub-echo-exec-agent';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-echo-exec-agent-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { vsockPath: join(dir, 'vsock.sock') };
}

test('it answers the request with STARTED carrying the pid', async () => {
  const ctx = setupTest();

  await startStubEchoExecAgent(ctx.vsockPath, {
    pid: 42,
    stderr: new TextEncoder().encode('bye'),
    exit: { code: 3, signal: 0 },
  });

  const connection = await openAgentConnection(ctx.vsockPath);

  onTestFinished(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, { op: 'exec', argv: ['cat'], tty: false });

  const frame = await connection.next();

  expect(frame).toStrictEqual({
    type: FRAME_TYPES.started,
    payload: new TextEncoder().encode('{"pid":42}'),
  });
});

test('it sends each stdin frame back as its own stdout frame', async () => {
  const ctx = setupTest();

  await startStubEchoExecAgent(ctx.vsockPath, {
    pid: 42,
    stderr: new TextEncoder().encode('bye'),
    exit: { code: 3, signal: 0 },
  });

  const connection = await openAgentConnection(ctx.vsockPath);

  onTestFinished(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, { op: 'exec', argv: ['cat'], tty: false });
  connection.send(FRAME_TYPES.stdin, new TextEncoder().encode('one'));
  connection.send(FRAME_TYPES.stdin, new TextEncoder().encode('two'));

  const frames = [await connection.next(), await connection.next(), await connection.next()];

  expect(frames).toStrictEqual([
    { type: FRAME_TYPES.started, payload: new TextEncoder().encode('{"pid":42}') },
    { type: FRAME_TYPES.stdout, payload: new TextEncoder().encode('one') },
    { type: FRAME_TYPES.stdout, payload: new TextEncoder().encode('two') },
  ]);
});

test('it sends the stderr, then the exit, and ends the connection on stdin EOF', async () => {
  const ctx = setupTest();

  await startStubEchoExecAgent(ctx.vsockPath, {
    pid: 42,
    stderr: new TextEncoder().encode('bye'),
    exit: { code: 3, signal: 0 },
  });

  const connection = await openAgentConnection(ctx.vsockPath);

  onTestFinished(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, { op: 'exec', argv: ['cat'], tty: false });
  connection.send(FRAME_TYPES.stdinEof);

  const frames = [
    await connection.next(),
    await connection.next(),
    await connection.next(),
    await connection.next(),
  ];

  expect(frames).toStrictEqual([
    { type: FRAME_TYPES.started, payload: new TextEncoder().encode('{"pid":42}') },
    { type: FRAME_TYPES.stderr, payload: new TextEncoder().encode('bye') },
    { type: FRAME_TYPES.exit, payload: new TextEncoder().encode('{"code":3,"signal":0}') },
    null,
  ]);
});
