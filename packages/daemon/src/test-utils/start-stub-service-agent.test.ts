import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import {
  openServiceLogStream,
  sendServicesAdd,
  sendServicesList,
  sendServicesRemove,
  sendServicesRestart,
} from '../agent-client/service-requests';
import { startStubServiceAgent } from './start-stub-service-agent';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-service-agent-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { vsockPath: join(dir, 'v.sock') };
}

test('it lists an added service with its definition, its pid and the image user', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'], env: ['A=1'] }, false);

  const listed = await sendServicesList(ctx.vsockPath);

  expect(listed).toStrictEqual({
    services: [
      {
        name: 'web',
        state: 'running',
        pid: 40,
        restarts: 0,
        def: { name: 'web', argv: ['httpd'], env: ['A=1'], restart: 'always', source: 'api' },
        root: false,
      },
    ],
    image_user: 'dev',
  });

  expect(agent.requests.map((request) => request.op)).toStrictEqual([
    'services.add',
    'services.list',
  ]);
});

test('it lists a service that runs as root as root', async () => {
  const ctx = await setupTest();

  await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });
  await sendServicesAdd(ctx.vsockPath, { name: 'db', argv: ['postgres'], user: 'root' }, false);

  const listed = await sendServicesList(ctx.vsockPath);

  expect(listed.services).toMatchObject([{ name: 'db', root: true }]);
});

test('it refuses an add of a name it has as SERVICE_EXISTS', async () => {
  const ctx = await setupTest();

  await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });
  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);

  expect(
    sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false),
  ).rejects.toMatchObject({ code: 'SERVICE_EXISTS' });
});

test('it replaces a service it has when the add replaces', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);
  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd', '-v'] }, true);

  expect(agent.services.map((service) => service.def?.argv)).toStrictEqual([['httpd', '-v']]);
});

test('it refuses an argv of bad as BAD_REQUEST', async () => {
  const ctx = await setupTest();

  await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  expect(
    sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['bad'] }, false),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses a remove of a service it lacks as NO_SERVICE', async () => {
  const ctx = await setupTest();

  await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  expect(sendServicesRemove(ctx.vsockPath, 'web')).rejects.toMatchObject({ code: 'NO_SERVICE' });
});

test('it removes a service and restarts another', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);
  await sendServicesAdd(ctx.vsockPath, { name: 'db', argv: ['postgres'] }, false);
  await sendServicesRemove(ctx.vsockPath, 'web');
  await sendServicesRestart(ctx.vsockPath, 'db');

  expect(agent.services.map((service) => service.name)).toStrictEqual(['db']);
});

test('it lists without definitions or an image user as an agent from before the services API', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: false });

  agent.services.push({ name: 'dockerd', state: 'running', pid: 212, restarts: 0 });

  const listed = await sendServicesList(ctx.vsockPath);

  expect(listed).toStrictEqual({
    services: [{ name: 'dockerd', state: 'running', pid: 212, restarts: 0 }],
  });
});

test('it refuses an add with UNKNOWN_OP as an agent from before the services API', async () => {
  const ctx = await setupTest();

  await startStubServiceAgent(ctx.vsockPath, { knowsServices: false });

  // the client reads the agent's UNKNOWN_OP as an outdated agent
  expect(
    sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('it refuses a list as INTERNAL while the list fails', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.failing.list = true;

  expect(sendServicesList(ctx.vsockPath)).rejects.toMatchObject({ code: 'INTERNAL' });
});

test('it sends a log from the cursor, then the cursor at its end, and ends', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\ntwo\n');

  const stream = await openServiceLogStream(ctx.vsockPath, {
    service: 'web',
    lines: 100,
    follow: false,
    cursor: { inode: 7, offset: 4 },
  });

  const chunks = await Array.fromAsync(stream.chunks());

  expect(chunks).toStrictEqual([
    { kind: 'data', data: new TextEncoder().encode('two\n') },
    { kind: 'cursor', cursor: { inode: 7, offset: 8 } },
  ]);
});

test('it sends what a write adds to an open follow', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\n');

  const stream = await openServiceLogStream(ctx.vsockPath, {
    service: 'web',
    lines: 100,
    follow: true,
  });

  onTestFinished(stream.close);

  const chunks = stream.chunks();

  const first = await chunks.next();
  const firstCursor = await chunks.next();

  agent.writeLog('web', 'two\n');

  const second = await chunks.next();

  expect(first.value).toStrictEqual({ kind: 'data', data: new TextEncoder().encode('one\n') });
  expect(firstCursor.value).toStrictEqual({ kind: 'cursor', cursor: { inode: 7, offset: 4 } });
  expect(second.value).toStrictEqual({ kind: 'data', data: new TextEncoder().encode('two\n') });
});

test('it drops every follow as a VM going to sleep does', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', '');

  const stream = await openServiceLogStream(ctx.vsockPath, {
    service: 'web',
    lines: 100,
    follow: true,
  });

  onTestFinished(stream.close);

  await waitFor(() => {
    if (agent.follows.length === 0) {
      throw new Error('no follow yet');
    }
  });

  agent.stopFollows();

  await waitFor(() => {
    if (agent.follows.some((follow) => !follow.isClosed)) {
      throw new Error('a follow is still open');
    }
  });

  expect(agent.follows).toHaveLength(1);
});

test('it refuses a log open as INTERNAL while the opens fail', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\n');

  agent.failing.logs = true;

  expect(
    openServiceLogStream(ctx.vsockPath, { service: 'web', lines: 100, follow: false }),
  ).rejects.toMatchObject({ code: 'INTERNAL' });
});
