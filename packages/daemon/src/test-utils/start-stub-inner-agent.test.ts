import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { ActivitySchema, PingSchema } from '../agent-client/agent-protocol';
import { sendActivity, sendAgentRequest, sendPing } from '../agent-client/agent-requests';
import { startStubInnerAgent } from './start-stub-inner-agent';

// a temp dir for the agent's socket, and `stack`, whose releases (the
// agent's first) run before the dir goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-inner-agent-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir, stack };
}

test('it reports the inner container it was given in its ping', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubInnerAgent(path, {
    inner: { up: false, restarts: 2, lastError: 'exit status 1' },
    stack: ctx.stack,
  });

  const ping = await sendPing(path);

  expect(ping).toStrictEqual(
    create(PingSchema, {
      ok: true,
      version: '0.18.0',
      inner: { up: false, restarts: 2, lastError: 'exit status 1' },
    }),
  );
});

test('it writes an inner container’s zero fields, as the agent does', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubInnerAgent(path, { inner: { up: false, restarts: 0 }, stack: ctx.stack });

  const response = await sendAgentRequest(path, { op: 'ping' });

  expect(response).toStrictEqual({
    ok: true,
    version: '0.18.0',
    inner: { up: false, restarts: 0 },
  });
});

test('it answers the activity with no connections and no sessions', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubInnerAgent(path, { inner: { up: true, restarts: 0 }, stack: ctx.stack });

  const activity = await sendActivity(path);

  expect(activity).toStrictEqual(
    create(ActivitySchema, { tcpEstablished: 0, execSessions: 0, load1: 0, sessions: [] }),
  );
});

test('it answers any other op UNKNOWN_OP', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubInnerAgent(path, { inner: { up: true, restarts: 0 }, stack: ctx.stack });

  expect(sendAgentRequest(path, { op: 'thaw' })).rejects.toMatchObject({ code: 'UNKNOWN_OP' });
});
