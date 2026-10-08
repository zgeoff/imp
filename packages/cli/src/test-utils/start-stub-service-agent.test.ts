import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendAgentRequest } from '@imp/daemon/src/agent-client/agent-requests';
import { sendServicesAdd, sendServicesList } from '@imp/daemon/src/agent-client/service-requests';
import { startStubServiceAgent } from './start-stub-service-agent';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-service-agent-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const vsockPath = join(dir, 'vsock.sock');

  const agent = await startStubServiceAgent(vsockPath);

  stack.defer(() => {
    agent.close();
  });

  return { vsockPath, agent };
}

test('it records each request as impd sends it', async () => {
  const ctx = await setupTest();

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd', '-f'] }, true);

  expect(ctx.agent.requests).toStrictEqual([
    { op: 'services.add', def: { name: 'web', argv: ['httpd', '-f'] }, replace: true },
  ]);
});

test('it lists the services added by name, as the agent does, with the image user', async () => {
  const ctx = await setupTest();

  await sendServicesAdd(ctx.vsockPath, { name: 'worker', argv: ['worker'] }, false);
  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);

  const listed = await sendServicesList(ctx.vsockPath);

  expect(listed).toStrictEqual({
    services: [
      { name: 'web', state: 'running', pid: 41, restarts: 0 },
      { name: 'worker', state: 'running', pid: 40, restarts: 0 },
    ],
    image_user: 'dev',
  });
});

test('it refuses an add of a name it has as SERVICE_EXISTS without replace', async () => {
  const ctx = await setupTest();

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);

  expect(
    sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd', '-f'] }, false),
  ).rejects.toMatchObject({
    code: 'SERVICE_EXISTS',
    message: 'SERVICE_EXISTS: service web exists',
  });
});

test('it keeps one service of a name it replaces', async () => {
  const ctx = await setupTest();

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);
  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd', '-f'] }, true);

  const listed = await sendServicesList(ctx.vsockPath);

  expect(listed).toStrictEqual({
    services: [{ name: 'web', state: 'running', pid: 40, restarts: 0 }],
    image_user: 'dev',
  });
});

test('it refuses an op it does not know as UNKNOWN_OP', async () => {
  const ctx = await setupTest();

  expect(
    sendAgentRequest(ctx.vsockPath, { op: 'services.restart', service: 'web' }),
  ).rejects.toMatchObject({
    code: 'UNKNOWN_OP',
  });
});

test('it takes no request once closed', async () => {
  const ctx = await setupTest();

  ctx.agent.close();

  expect(sendServicesList(ctx.vsockPath)).rejects.toThrow();
});
