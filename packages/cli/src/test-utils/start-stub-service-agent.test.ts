import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendAgentRequest } from '@imp/daemon/src/agent-client/agent-requests';
import { sendServicesAdd, sendServicesList } from '@imp/daemon/src/agent-client/service-requests';
import { startStubServiceAgent } from './start-stub-service-agent';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'stub-service-agent-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  return { dir, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it records each request as impd sends it', async () => {
  await using ctx = await setupTest();

  const vsockPath = join(ctx.dir, 'vsock.sock');

  const agent = await startStubServiceAgent(vsockPath);

  onTestFinished(() => {
    agent.close();
  });

  await sendServicesAdd(vsockPath, { name: 'web', argv: ['httpd', '-f'] }, true);

  expect(agent.requests).toStrictEqual([
    { op: 'services.add', def: { name: 'web', argv: ['httpd', '-f'] }, replace: true },
  ]);
});

test('it lists the services added, with the image user', async () => {
  await using ctx = await setupTest();

  const vsockPath = join(ctx.dir, 'vsock.sock');

  const agent = await startStubServiceAgent(vsockPath);

  onTestFinished(() => {
    agent.close();
  });

  await sendServicesAdd(vsockPath, { name: 'web', argv: ['httpd'] }, false);
  await sendServicesAdd(vsockPath, { name: 'web', argv: ['httpd', '-f'] }, true);

  const listed = await sendServicesList(vsockPath);

  expect(listed).toStrictEqual({
    services: [{ name: 'web', state: 'running', pid: 40, restarts: 0 }],
    image_user: 'dev',
  });
});

test('it refuses an op it does not know as UNKNOWN_OP', async () => {
  await using ctx = await setupTest();

  const vsockPath = join(ctx.dir, 'vsock.sock');

  const agent = await startStubServiceAgent(vsockPath);

  onTestFinished(() => {
    agent.close();
  });

  expect(
    sendAgentRequest(vsockPath, { op: 'services.restart', service: 'web' }),
  ).rejects.toMatchObject({
    code: 'UNKNOWN_OP',
  });
});
