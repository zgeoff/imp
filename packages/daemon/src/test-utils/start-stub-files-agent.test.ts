import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendAgentRequest } from '../agent-client/agent-requests';
import { sendFilesRemove, sendFilesWrite } from '../agent-client/file-requests';
import { startStubFilesAgent } from './start-stub-files-agent';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-files-agent-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { vsockPath: join(dir, 'v.sock') };
}

test('it keeps the content a write sends under its path', async () => {
  const ctx = await setupTest();
  const agent = await startStubFilesAgent(ctx.vsockPath, { knowsFiles: true });

  await sendFilesWrite(ctx.vsockPath, 'notes/today.json', new TextEncoder().encode('{"a":1}'));

  expect([...agent.files]).toStrictEqual([['notes/today.json', '{"a":1}']]);
});

test('it replaces the content of a path written again', async () => {
  const ctx = await setupTest();
  const agent = await startStubFilesAgent(ctx.vsockPath, { knowsFiles: true });

  await sendFilesWrite(ctx.vsockPath, 'notes/today.json', new TextEncoder().encode('{"a":1}'));
  await sendFilesWrite(ctx.vsockPath, 'notes/today.json', new TextEncoder().encode('{"a":2}'));

  expect([...agent.files]).toStrictEqual([['notes/today.json', '{"a":2}']]);
});

test('it removes a file and reports that it was there', async () => {
  const ctx = await setupTest();
  const agent = await startStubFilesAgent(ctx.vsockPath, { knowsFiles: true });

  await sendFilesWrite(ctx.vsockPath, 'notes/today.json', new TextEncoder().encode('{}'));

  const removed = await sendFilesRemove(ctx.vsockPath, 'notes/today.json');

  expect(removed).toBe(true);
  expect(agent.files.size).toBe(0);
});

test('it reports a remove of a missing file as not removed', async () => {
  const ctx = await setupTest();

  await startStubFilesAgent(ctx.vsockPath, { knowsFiles: true });

  const removed = await sendFilesRemove(ctx.vsockPath, 'notes/today.json');

  expect(removed).toBe(false);
});

test('it refuses a path the agent refuses as BAD_REQUEST', async () => {
  const ctx = await setupTest();
  const agent = await startStubFilesAgent(ctx.vsockPath, { knowsFiles: true });

  expect(
    sendFilesWrite(ctx.vsockPath, '../today.json', new TextEncoder().encode('{}')),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

  await expect(sendFilesRemove(ctx.vsockPath, 'notes/.staged')).toReject();

  expect(agent.files.size).toBe(0);
});

test('it refuses data over the agent’s cap as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  await startStubFilesAgent(ctx.vsockPath, { knowsFiles: true });

  expect(sendFilesWrite(ctx.vsockPath, 'big.json', new Uint8Array(524_289))).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it refuses a write while full as NO_SPACE', async () => {
  const ctx = await setupTest();
  const agent = await startStubFilesAgent(ctx.vsockPath, { knowsFiles: true });

  agent.full.isFull = true;

  expect(
    sendFilesWrite(ctx.vsockPath, 'notes/today.json', new TextEncoder().encode('{}')),
  ).rejects.toMatchObject({ code: 'NO_SPACE' });
});

test('it answers UNKNOWN_OP as an agent from before the read-only files', async () => {
  const ctx = await setupTest();

  await startStubFilesAgent(ctx.vsockPath, { knowsFiles: false });

  expect(
    sendAgentRequest(ctx.vsockPath, { op: 'files.remove', path: 'notes/today.json' }),
  ).rejects.toMatchObject({ code: 'UNKNOWN_OP' });
});

test('it turns an older agent’s UNKNOWN_OP into AGENT_OUTDATED', async () => {
  const ctx = await setupTest();

  await startStubFilesAgent(ctx.vsockPath, { knowsFiles: false });

  expect(sendFilesRemove(ctx.vsockPath, 'notes/today.json')).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
  });
});

test('it records every request in order', async () => {
  const ctx = await setupTest();
  const agent = await startStubFilesAgent(ctx.vsockPath, { knowsFiles: true });

  await sendFilesWrite(ctx.vsockPath, 'notes/today.json', new TextEncoder().encode('{}'));
  await sendFilesRemove(ctx.vsockPath, 'notes/today.json');

  expect(agent.requests.map((request) => [request.op, request.path])).toStrictEqual([
    ['files.write', 'notes/today.json'],
    ['files.remove', 'notes/today.json'],
  ]);
});
