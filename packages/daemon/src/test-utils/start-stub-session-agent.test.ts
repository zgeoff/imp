import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { sendActivity } from '../agent-client/agent-requests';
import { openExecStream } from '../agent-client/exec-stream';
import { startStubSessionAgent } from './start-stub-session-agent';

// a temp dir for the agent's socket, and `stack`, whose releases (the
// agent's and the streams') run before the dir goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-session-agent-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir, stack };
}

test('it answers a plain exec with STARTED and no session', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubSessionAgent(path, { stack: ctx.stack });

  const stream = await openExecStream(path, { argv: ['true'], tty: false });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(stream.pid).toBe(9);
  expect(stream.session).toBeNull();
});

test('it starts a new run for a session name it does not know', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, {
    bootId: '11111111-1111-4111-8111-111111111111',
    stack: ctx.stack,
  });

  const stream = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    stream.close();
  });

  const run = agent.readRun('main');

  invariant(run);

  expect(stream.created).toBeTrue();
  expect(run.generation).toMatch(/^[0-9a-f]{32}$/);
  expect(run.state).toBe('running');
  expect(run.isAttached).toBeTrue();

  expect(stream.output).toMatchObject({
    bootId: '11111111-1111-4111-8111-111111111111',
    executionGeneration: run.generation,
  });
});

test('it attaches to a running session and takes it over from its viewer', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    first.close();
  });

  const run = agent.readRun('main');

  invariant(run);

  const second = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    second.close();
  });

  const events = await Array.fromAsync(first.events());

  expect(second.created).toBeFalse();
  expect(second.output).toMatchObject({ executionGeneration: run.generation });
  expect(events).toStrictEqual([{ type: 'detached', reason: 'taken_over' }]);
});

test('it starts a new run for an exited session opened without a resume', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  const exited = agent.readRun('main');

  invariant(exited);

  first.close();
  agent.exitRun('main');

  const second = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    second.close();
  });

  expect(second.created).toBeTrue();
  expect(agent.readRun('main')?.generation).not.toBe(exited.generation);
});

test('it attaches to an exited run on a resume of its generation', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  const exited = agent.readRun('main');

  invariant(exited);

  first.close();
  agent.exitRun('main');

  const resumed = await openExecStream(path, {
    argv: ['sh'],
    tty: true,
    session: 'main',
    resumeFrom: { executionGeneration: exited.generation, offset: 0 },
  });

  ctx.stack.defer(() => {
    resumed.close();
  });

  expect(resumed.created).toBeFalse();
  expect(resumed.output).toMatchObject({ executionGeneration: exited.generation });
});

test('it lists every run in its activity, exited ones included', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const job = await openExecStream(path, { argv: ['sh'], tty: true, session: 'job' });

  job.close();
  agent.exitRun('job');

  const main = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  const activity = await sendActivity(path);

  expect(activity.sessions).toMatchObject([
    { name: 'job', state: 'exited', attached: false },
    { name: 'main', state: 'running', attached: true },
  ]);
});

test('it lists the exec requests it got, not its activity requests', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });

  await sendActivity(path);

  const stream = await openExecStream(path, { argv: ['true'], tty: false, env: ['A=1'] });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(agent.readExecs()).toStrictEqual([
    { op: 'exec', argv: ['true'], tty: false, env: ['A=1'] },
  ]);
});

test('it sends a run’s output to the client attached to it', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const stream = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    stream.close();
  });

  agent.writeOutput('main', Buffer.from('hi'));

  const first = await stream.events().next();

  expect(first.value).toStrictEqual({ type: 'stdout', data: Buffer.from('hi') });
});

test('it refuses output for a session with no client attached', async () => {
  const ctx = await setupTest();
  const agent = await startStubSessionAgent(join(ctx.dir, 'v.sock'), { stack: ctx.stack });

  expect(() => {
    agent.writeOutput('main', Buffer.from('hi'));
  }).toThrow('no client attached to session main');
});

test('it refuses to exit a run of a session it does not know', async () => {
  const ctx = await setupTest();
  const agent = await startStubSessionAgent(join(ctx.dir, 'v.sock'), { stack: ctx.stack });

  expect(() => {
    agent.exitRun('main');
  }).toThrow('no run of session main');
});

test('it forgets every run once the guest boots cold', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const stream = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  stream.close();
  agent.clearRuns();

  expect(agent.readRun('main')).toBeUndefined();
});

test('it stops listening once its stack is released', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const stack = new AsyncDisposableStack();

  await startStubSessionAgent(path, { stack });

  await stack.disposeAsync();

  expect(openExecStream(path, { argv: ['true'], tty: false })).rejects.toThrow();
});
