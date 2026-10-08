import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { openExecStream, openTapStream } from '../agent-client/exec-stream';
import { buildStubExecGuest } from './build-stub-exec-guest';
import { startStubExecAgent } from './start-stub-exec-agent';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-exec-agent-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { stack, dir };
}

test('it runs an exec on the guest and sends its output and exit as frames', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'echo hi'],
    tty: false,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hi\n') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it hands the guest the request as impd sent it', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'echo hi'],
    env: ['A=1'],
    cwd: '/work',
    tty: false,
    killGraceMs: 50,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(guest.requests).toStrictEqual([
    { argv: ['/bin/sh', '-c', 'echo hi'], env: ['A=1'], cwd: '/work', tty: false, killGraceMs: 50 },
  ]);
});

test('it reports the guest’s group kill in STARTED', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
    killGraceMs: 50,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(stream.groupKill).toBeTrue();
});

test('it passes a signal to the guest’s command', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  stream.sendSignal(15);

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'exit', code: 143, signal: 15 }]);
  expect(guest.signals).toStrictEqual(['sleepy:15']);
});

test('it passes stdin and its end to the guest’s command', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'cat'],
    tty: false,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  stream.writeStdin(new TextEncoder().encode('typed'));
  stream.closeStdin();

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('typed') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it closes the guest’s stream when impd drops the connection', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
  });

  stream.close();

  await waitFor(() => {
    expect(guest.closed).toStrictEqual(['sleepy']);
  });
});

test('it refuses an op other than exec', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  // the agent's UNKNOWN_OP reaches impd as an agent too old for the op
  expect(openTapStream(join(ctx.dir, 'v.sock'), 'web')).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
  });
});
