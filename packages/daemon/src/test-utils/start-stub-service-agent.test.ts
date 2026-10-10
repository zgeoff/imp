import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { sendAgentRequest } from '../agent-client/agent-requests';
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
  ).rejects.toMatchObject({
    code: 'SERVICE_EXISTS',
    message: 'SERVICE_EXISTS: service web exists',
  });
});

test('it refuses an op it does not know as UNKNOWN_OP', async () => {
  const ctx = await setupTest();

  await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  expect(sendAgentRequest(ctx.vsockPath, { op: 'services.bogus' })).rejects.toMatchObject({
    code: 'UNKNOWN_OP',
  });
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

test('it removes the service a remove names', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);
  await sendServicesAdd(ctx.vsockPath, { name: 'db', argv: ['postgres'] }, false);
  await sendServicesRemove(ctx.vsockPath, 'web');

  expect(agent.services.map((service) => service.name)).toStrictEqual(['db']);
});

test('it refuses a remove of a service that left only its log as NO_SERVICE', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'db', argv: ['postgres'] }, false);

  agent.writeLog('web', 'one\n');

  expect(sendServicesRemove(ctx.vsockPath, 'web')).rejects.toMatchObject({
    code: 'NO_SERVICE',
    message: 'NO_SERVICE: no service web',
  });
});

test('it keeps every service when it refuses a remove of a log alone', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'db', argv: ['postgres'] }, false);

  agent.writeLog('web', 'one\n');

  await expect(sendServicesRemove(ctx.vsockPath, 'web')).toReject();

  expect(agent.services.map((service) => service.name)).toStrictEqual(['db']);
});

test('it restarts a service under a new pid', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);
  await sendServicesRestart(ctx.vsockPath, 'web');

  expect(agent.services).toMatchObject([{ name: 'web', state: 'running', pid: 41 }]);
});

test('it restarts a service without the last exit of its old process', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.services.push({
    name: 'web',
    state: 'backoff',
    pid: 0,
    restarts: 2,
    last_exit: { code: 1, signal: 0 },
  });

  await sendServicesRestart(ctx.vsockPath, 'web');

  expect(agent.services).toStrictEqual([{ name: 'web', state: 'running', pid: 40, restarts: 0 }]);
});

test('it refuses a restart of a service that left only its log as NO_SERVICE', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\n');

  expect(sendServicesRestart(ctx.vsockPath, 'web')).rejects.toMatchObject({
    code: 'NO_SERVICE',
    message: 'NO_SERVICE: no service web',
  });
});

test('it lists the services by name', async () => {
  const ctx = await setupTest();

  await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });
  await sendServicesAdd(ctx.vsockPath, { name: 'worker', argv: ['worker'] }, false);
  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);

  const listed = await sendServicesList(ctx.vsockPath);

  expect(listed.services.map((service) => service.name)).toStrictEqual(['web', 'worker']);
});

test('it runs a replaced service under a new pid', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);
  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd', '-v'] }, true);

  expect(agent.services).toMatchObject([{ name: 'web', pid: 41 }]);
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

test('it sends the last lines a log call asks for without a cursor', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\ntwo\nthree\n');

  const stream = await openServiceLogStream(ctx.vsockPath, {
    service: 'web',
    lines: 2,
    follow: false,
  });

  const chunks = await Array.fromAsync(stream.chunks());

  expect(chunks).toStrictEqual([
    { kind: 'data', data: new TextEncoder().encode('two\nthree\n') },
    { kind: 'cursor', cursor: { inode: 7, offset: 14 } },
  ]);
});

test('it counts a last line without a newline as a line', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\ntwo\nthr');

  const stream = await openServiceLogStream(ctx.vsockPath, {
    service: 'web',
    lines: 2,
    follow: false,
  });

  const chunks = await Array.fromAsync(stream.chunks());

  expect(chunks).toStrictEqual([
    { kind: 'data', data: new TextEncoder().encode('two\nthr') },
    { kind: 'cursor', cursor: { inode: 7, offset: 11 } },
  ]);
});

test('it sends the whole log when it holds fewer lines than asked', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\ntwo\n');

  const stream = await openServiceLogStream(ctx.vsockPath, {
    service: 'web',
    lines: 5,
    follow: false,
  });

  const chunks = await Array.fromAsync(stream.chunks());

  expect(chunks).toStrictEqual([
    { kind: 'data', data: new TextEncoder().encode('one\ntwo\n') },
    { kind: 'cursor', cursor: { inode: 7, offset: 8 } },
  ]);
});

test('it sends nothing of a log for zero lines', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\ntwo\n');

  const stream = await openServiceLogStream(ctx.vsockPath, {
    service: 'web',
    lines: 0,
    follow: false,
  });

  const chunks = await Array.fromAsync(stream.chunks());

  expect(chunks).toStrictEqual([]);
});

test('it sends the whole log from a cursor past its end, as after a truncate', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\n');

  const stream = await openServiceLogStream(ctx.vsockPath, {
    service: 'web',
    lines: 100,
    follow: false,
    cursor: { inode: 7, offset: 50 },
  });

  const chunks = await Array.fromAsync(stream.chunks());

  expect(chunks).toStrictEqual([
    { kind: 'data', data: new TextEncoder().encode('one\n') },
    { kind: 'cursor', cursor: { inode: 7, offset: 4 } },
  ]);
});

test('it refuses a log call for more than 100000 lines as BAD_REQUEST', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.writeLog('web', 'one\n');

  expect(
    openServiceLogStream(ctx.vsockPath, { service: 'web', lines: 100_001, follow: false }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses a log call for a name with no service and no log as NO_SERVICE', async () => {
  const ctx = await setupTest();

  await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  expect(
    openServiceLogStream(ctx.vsockPath, { service: 'web', lines: 100, follow: false }),
  ).rejects.toMatchObject({ code: 'NO_SERVICE' });
});

test('it sends the log a removed service left', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd'] }, false);

  agent.writeLog('web', 'one\n');

  await sendServicesRemove(ctx.vsockPath, 'web');

  const stream = await openServiceLogStream(ctx.vsockPath, {
    service: 'web',
    lines: 100,
    follow: false,
  });

  const chunks = await Array.fromAsync(stream.chunks());

  expect(chunks).toStrictEqual([
    { kind: 'data', data: new TextEncoder().encode('one\n') },
    { kind: 'cursor', cursor: { inode: 7, offset: 4 } },
  ]);
});

test('it records each request as impd sends it', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  await sendServicesAdd(ctx.vsockPath, { name: 'web', argv: ['httpd', '-f'] }, true);

  expect(agent.requests).toStrictEqual([
    { op: 'services.add', def: { name: 'web', argv: ['httpd', '-f'] }, replace: true },
  ]);
});

test('it takes no request once closed', async () => {
  const ctx = await setupTest();
  const agent = await startStubServiceAgent(ctx.vsockPath, { knowsServices: true });

  agent.close();

  expect(sendServicesList(ctx.vsockPath)).rejects.toThrow();
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
