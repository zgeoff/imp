import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { sendActivity } from '../agent-client/agent-requests';
import { openAttachStream, openExecStream, openTapStream } from '../agent-client/exec-stream';
import { startStubSessionAgent } from './start-stub-session-agent';

// The stand-in's assumptions are agent/internal/session's: Manager.find,
// session.attach and session.tap there, and Activity.ExecSessions.

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

  expect(stream.output).toStrictEqual({
    continuity: 'offsets',
    bootId: '11111111-1111-4111-8111-111111111111',
    executionGeneration: run.generation,
    bufferStart: 0,
    end: 0,
    offset: 0,
    prelude: 0,
    coldBoots: [],
  });
});

test('it refuses a session without a tty', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubSessionAgent(path, { stack: ctx.stack });

  expect(openExecStream(path, { argv: ['sh'], tty: false, session: 'main' })).rejects.toMatchObject(
    { code: 'BAD_REQUEST', detail: 'a session needs a tty' },
  );
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

test('it detaches the viewer when its connection closes', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const stream = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  stream.close();

  await waitFor(() => {
    expect(agent.readRun('main')?.isAttached).toBeFalse();
  });

  expect(agent.readRun('main')?.state).toBe('running');
});

test('it keeps output written with no viewer and replays it to the next one', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  first.close();

  await waitFor(() => {
    expect(agent.readRun('main')?.isAttached).toBeFalse();
  });

  agent.writeOutput('main', Buffer.from('kept'));

  const second = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    second.close();
  });

  const replay = await second.events().next();

  expect(second.output).toMatchObject({ end: 4, offset: 0 });
  expect(replay.value).toStrictEqual({ type: 'stdout', data: Buffer.from('kept') });
});

test('it sends the EXIT to the viewer attached when the run exits, and the run is over', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const stream = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    stream.close();
  });

  agent.exitRun('main', { code: 3, signal: 0 });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'exit', code: 3, signal: 0 }]);
  expect(agent.readRun('main')).toBeUndefined();
});

test('it starts a new run for an exited session opened without a resume, naming the old one as previous', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  const exited = agent.readRun('main');

  invariant(exited);

  first.close();

  await waitFor(() => {
    expect(agent.readRun('main')?.isAttached).toBeFalse();
  });

  agent.writeOutput('main', Buffer.from('bye'));
  agent.exitRun('main', { code: 2, signal: 0 });

  const second = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    second.close();
  });

  expect(second.created).toBeTrue();
  expect(agent.readRun('main')?.generation).not.toBe(exited.generation);

  expect(second.output).toMatchObject({
    previous: { executionGeneration: exited.generation, end: 3, exitCode: 2 },
  });
});

test('it sends STARTED then the EXIT on a resume of an exited run', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  const exited = agent.readRun('main');

  invariant(exited);

  first.close();

  await waitFor(() => {
    expect(agent.readRun('main')?.isAttached).toBeFalse();
  });

  agent.writeOutput('main', Buffer.from('done'));
  agent.exitRun('main', { code: 0, signal: 0 });

  const resumed = await openExecStream(path, {
    argv: ['sh'],
    tty: true,
    session: 'main',
    resumeFrom: { executionGeneration: exited.generation, offset: 2 },
  });

  ctx.stack.defer(() => {
    resumed.close();
  });

  const events = await Array.fromAsync(resumed.events());

  expect(resumed.created).toBeFalse();

  expect(resumed.output).toMatchObject({
    executionGeneration: exited.generation,
    offset: 2,
    resume: { kind: 'exact' },
  });

  expect(events).toStrictEqual([
    { type: 'stdout', data: Buffer.from('ne') },
    { type: 'exit', code: 0, signal: 0 },
  ]);

  expect(agent.readRun('main')).toBeUndefined();
});

test('it marks a resume of another generation as generation_changed and sends this one from 0', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    first.close();
  });

  const run = agent.readRun('main');

  invariant(run);

  const resumed = await openExecStream(path, {
    argv: ['sh'],
    tty: true,
    session: 'main',
    resumeFrom: { executionGeneration: 'f'.repeat(32), offset: 7 },
  });

  ctx.stack.defer(() => {
    resumed.close();
  });

  expect(resumed.output).toMatchObject({
    offset: 0,
    resume: { kind: 'generation_changed', executionGeneration: run.generation, firstOffset: 0 },
  });
});

test('it refuses a resume past the end of the output with INVALID_RESUME', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    first.close();
  });

  const run = agent.readRun('main');

  invariant(run);

  expect(
    openExecStream(path, {
      argv: ['sh'],
      tty: true,
      session: 'main',
      resumeFrom: { executionGeneration: run.generation, offset: 5 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_RESUME', data: { end: 0, bufferStart: 0 } });
});

test('it answers session.attach to a name with no run with NO_SESSION and the previous run', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, {
    bootId: '22222222-2222-4222-8222-222222222222',
    stack: ctx.stack,
  });

  const stream = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    stream.close();
  });

  const run = agent.readRun('main');

  invariant(run);

  agent.exitRun('main', { code: 1, signal: 0 });

  expect(openAttachStream(path, { session: 'main' })).rejects.toMatchObject({
    code: 'NO_SESSION',
    data: {
      bootId: '22222222-2222-4222-8222-222222222222',
      coldBoots: [],
      previous: { executionGeneration: run.generation, end: 0, exitCode: 1 },
    },
  });
});

test('it starts no run on session.attach to an unknown name', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });

  expect(openAttachStream(path, { session: 'main' })).rejects.toMatchObject({ code: 'NO_SESSION' });
  expect(agent.readRun('main')).toBeUndefined();
});

test('it attaches session.attach to a running run as its viewer', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  first.close();

  await waitFor(() => {
    expect(agent.readRun('main')?.isAttached).toBeFalse();
  });

  const attached = await openAttachStream(path, { session: 'main' });

  ctx.stack.defer(() => {
    attached.close();
  });

  expect(attached.created).toBeFalse();
  expect(agent.readRun('main')?.isAttached).toBeTrue();
});

test('it taps a logged run without becoming its viewer', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const first = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main', log: true });

  first.close();

  await waitFor(() => {
    expect(agent.readRun('main')?.isAttached).toBeFalse();
  });

  const tapped = await openTapStream(path, 'main');

  ctx.stack.defer(() => {
    tapped.close();
  });

  agent.writeOutput('main', Buffer.from('log'));

  const chunk = await tapped.events().next();

  expect(agent.readRun('main')?.isAttached).toBeFalse();
  expect(chunk.value).toStrictEqual({ type: 'stdout', data: Buffer.from('log') });
});

test('it refuses a tap of a run kept with no log', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubSessionAgent(path, { stack: ctx.stack });

  const stream = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(openTapStream(path, 'main')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses a tap of a name with no run with NO_SESSION', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  await startStubSessionAgent(path, { stack: ctx.stack });

  expect(openTapStream(path, 'main')).rejects.toMatchObject({ code: 'NO_SESSION' });
});

test('it counts open connections as exec_sessions, not runs and not taps', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const job = await openExecStream(path, { argv: ['sh'], tty: true, session: 'job', log: true });

  job.close();

  await waitFor(() => {
    expect(agent.readRun('job')?.isAttached).toBeFalse();
  });

  const main = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  const plain = await openExecStream(path, { argv: ['true'], tty: false });

  ctx.stack.defer(() => {
    plain.close();
  });

  const tapped = await openTapStream(path, 'job');

  ctx.stack.defer(() => {
    tapped.close();
  });

  const activity = await sendActivity(path);

  expect(activity.exec_sessions).toBe(2);
  expect(activity.sessions).toHaveLength(2);
});

test('it lists every run in its activity, exited ones with their exit', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const job = await openExecStream(path, { argv: ['sh'], tty: true, session: 'job' });

  job.close();

  await waitFor(() => {
    expect(agent.readRun('job')?.isAttached).toBeFalse();
  });

  agent.exitRun('job', { code: 0, signal: 9 });

  const main = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    main.close();
  });

  const activity = await sendActivity(path);

  expect(activity.sessions).toMatchObject([
    { name: 'job', state: 'exited', attached: false, exit: { code: 0, signal: 9 } },
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

test('it refuses output for a session it does not know', async () => {
  const ctx = await setupTest();
  const agent = await startStubSessionAgent(join(ctx.dir, 'v.sock'), { stack: ctx.stack });

  expect(() => {
    agent.writeOutput('main', Buffer.from('hi'));
  }).toThrow('no run of session main');
});

test('it refuses to exit a run of a session it does not know', async () => {
  const ctx = await setupTest();
  const agent = await startStubSessionAgent(join(ctx.dir, 'v.sock'), { stack: ctx.stack });

  expect(() => {
    agent.exitRun('main', { code: 0, signal: 0 });
  }).toThrow('no run of session main');
});

test('it forgets every run and every previous run once the guest boots cold', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const agent = await startStubSessionAgent(path, { stack: ctx.stack });
  const stream = await openExecStream(path, { argv: ['sh'], tty: true, session: 'main' });

  ctx.stack.defer(() => {
    stream.close();
  });

  agent.exitRun('main', { code: 0, signal: 0 });
  agent.clearRuns();

  expect(agent.readRun('main')).toBeUndefined();

  expect(openAttachStream(path, { session: 'main' })).rejects.toHaveProperty('data', {
    bootId: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
    coldBoots: [],
  });
});

test('it stops listening once its stack is released', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'v.sock');

  const stack = new AsyncDisposableStack();

  await startStubSessionAgent(path, { stack });

  await stack.disposeAsync();

  expect(openExecStream(path, { argv: ['true'], tty: false })).rejects.toThrow();
});
