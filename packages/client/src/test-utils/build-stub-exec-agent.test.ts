import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openAttachStream,
  openExecStream,
  openTapStream,
} from '@imp/daemon/src/agent-client/exec-stream';
import { startStubAgent } from '@imp/daemon/src/test-utils/start-stub-agent';
import { waitFor } from '@imp/test-utils/wait-for';
import {
  STUB_BOOT_ID,
  STUB_FLOOD_BYTES,
  STUB_GENERATION,
  buildStubExecAgent,
} from './build-stub-exec-agent';

// the stub on a socket in a temp dir, as impd's agent client reaches it
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-exec-agent-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const agent = buildStubExecAgent();
  const vsockPath = join(dir, 'v.sock');

  const server = await startStubAgent(vsockPath, agent.readFrame);

  stack.defer(() => {
    server.close();
  });

  return { agent, vsockPath };
}

test('it writes out and err and exits 3 for fail', async () => {
  const ctx = await setupTest();
  const stream = await openExecStream(ctx.vsockPath, { argv: ['fail'], tty: false });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('out') },
    { type: 'stderr', data: new TextEncoder().encode('err') },
    { type: 'exit', code: 3, signal: 0 },
  ]);
});

test('it refuses to start nope with EXEC_FAILED', async () => {
  const ctx = await setupTest();

  expect(openExecStream(ctx.vsockPath, { argv: ['nope'], tty: false })).rejects.toMatchObject({
    code: 'EXEC_FAILED',
  });
});

test('it echoes the stdin of cat and exits 0 when stdin ends', async () => {
  const ctx = await setupTest();
  const stream = await openExecStream(ctx.vsockPath, { argv: ['cat'], tty: false });

  stream.writeStdin(new TextEncoder().encode('hello'));
  stream.closeStdin();

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hello') },
    { type: 'exit', code: 0, signal: 0 },
  ]);

  expect(ctx.agent.input).toStrictEqual(['hello', 'eof']);
});

test('it floods both streams for big', async () => {
  const ctx = await setupTest();
  const stream = await openExecStream(ctx.vsockPath, { argv: ['big'], tty: false });
  const events = await Array.fromAsync(stream.events());

  const stdout = events.flatMap((event) => (event.type === 'stdout' ? [event.data] : []));
  const stderr = events.flatMap((event) => (event.type === 'stderr' ? [event.data] : []));

  expect(Buffer.concat(stdout)).toStrictEqual(Buffer.alloc(STUB_FLOOD_BYTES, 'o'));
  expect(Buffer.concat(stderr)).toStrictEqual(Buffer.alloc(STUB_FLOOD_BYTES, 'e'));
  expect(events.at(-1)).toStrictEqual({ type: 'exit', code: 0, signal: 0 });
});

test('it ends wait with the signal it gets', async () => {
  const ctx = await setupTest();
  const stream = await openExecStream(ctx.vsockPath, { argv: ['wait'], tty: false });

  stream.sendSignal(15);

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'exit', code: 143, signal: 15 }]);
  expect(ctx.agent.input).toStrictEqual(['signal:15']);
});

test('it ends the console shell on a ^C key and records a resize', async () => {
  const ctx = await setupTest();
  const stream = await openExecStream(ctx.vsockPath, { argv: ['/bin/sh'], tty: true });

  stream.resize(120, 40);
  stream.writeStdin(new TextEncoder().encode('\u0003'));

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'exit', code: 130, signal: 2 }]);
  expect(ctx.agent.input).toStrictEqual(['resize:120x40', '\u0003']);
});

test('it reports a group kill for a kill grace', async () => {
  const ctx = await setupTest();

  const stream = await openExecStream(ctx.vsockPath, {
    argv: ['wait'],
    tty: false,
    killGraceMs: 2000,
  });

  onTestFinished(() => {
    stream.close();
  });

  expect(stream.groupKill).toBeTrue();
});

test('it reports no group kill for old, an agent from before it', async () => {
  const ctx = await setupTest();

  const stream = await openExecStream(ctx.vsockPath, {
    argv: ['old'],
    tty: false,
    killGraceMs: 2000,
  });

  onTestFinished(() => {
    stream.close();
  });

  expect(stream.groupKill).toBeFalse();
});

test('it creates the session a start names, without offsets', async () => {
  const ctx = await setupTest();

  const stream = await openExecStream(ctx.vsockPath, {
    argv: ['/bin/sh'],
    tty: true,
    session: 'main',
  });

  onTestFinished(() => {
    stream.close();
  });

  expect({ session: stream.session, created: stream.created, output: stream.output }).toStrictEqual(
    { session: 'main', created: true, output: { continuity: 'none' } },
  );
});

test('it records each request in its wire form', async () => {
  const ctx = await setupTest();

  const stream = await openExecStream(ctx.vsockPath, {
    argv: ['fail'],
    tty: false,
    cwd: '/srv',
  });

  await Array.fromAsync(stream.events());

  expect(ctx.agent.requests).toStrictEqual([
    { op: 'exec', argv: ['fail'], tty: false, cwd: '/srv' },
  ]);
});

test('it records a command whose connection closed while it ran', async () => {
  const ctx = await setupTest();
  const stream = await openExecStream(ctx.vsockPath, { argv: ['tick'], tty: false });

  stream.close();

  await waitFor(() => {
    expect(ctx.agent.closed).toStrictEqual(['tick']);
  });
});

test('it never records a command that exited as closed', async () => {
  const ctx = await setupTest();
  const stream = await openExecStream(ctx.vsockPath, { argv: ['fail'], tty: false });

  await Array.fromAsync(stream.events());

  stream.close();

  const tick = await openExecStream(ctx.vsockPath, { argv: ['tick'], tty: false });

  tick.close();

  await waitFor(() => {
    expect(ctx.agent.closed).toStrictEqual(['tick']);
  });
});

test('it replays main and detaches it on a write of taken', async () => {
  const ctx = await setupTest();
  const stream = await openAttachStream(ctx.vsockPath, { session: 'main' });

  stream.writeStdin(new TextEncoder().encode('taken'));

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('replay') },
    { type: 'detached', reason: 'taken_over' },
  ]);
});

test('it resumes counted at its offset with the tail, then exits', async () => {
  const ctx = await setupTest();

  const stream = await openAttachStream(ctx.vsockPath, {
    session: 'counted',
    resumeFrom: { executionGeneration: STUB_GENERATION, offset: 95 },
  });

  const events = await Array.fromAsync(stream.events());

  expect(stream.output).toStrictEqual({
    continuity: 'offsets',
    bootId: STUB_BOOT_ID,
    executionGeneration: STUB_GENERATION,
    bufferStart: 0,
    end: 100,
    offset: 95,
    prelude: 0,
    coldBoots: [],
    resume: { kind: 'exact' },
  });

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('tail!') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it refuses ended with NO_SESSION and the generation that last ran', async () => {
  const ctx = await setupTest();

  expect(openAttachStream(ctx.vsockPath, { session: 'ended' })).rejects.toMatchObject({
    code: 'NO_SESSION',
    data: {
      bootId: STUB_BOOT_ID,
      coldBoots: [],
      previous: { executionGeneration: STUB_GENERATION, end: 100, exitCode: 0 },
    },
  });
});

test('it refuses a session it does not run with NO_SESSION and no data', async () => {
  const ctx = await setupTest();

  expect(openAttachStream(ctx.vsockPath, { session: 'gone' })).rejects.toMatchObject({
    code: 'NO_SESSION',
    data: undefined,
  });
});

test('it refuses a resume past the end with INVALID_RESUME', async () => {
  const ctx = await setupTest();

  expect(
    openAttachStream(ctx.vsockPath, {
      session: 'main',
      resumeFrom: { executionGeneration: STUB_GENERATION, offset: 101 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_RESUME', data: { end: 100, bufferStart: 0 } });
});

test('it refuses an op it does not know, as an agent from before it does', async () => {
  const ctx = await setupTest();

  expect(openTapStream(ctx.vsockPath, 'main')).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('it keeps serving after impd closes the connection of a command that floods', async () => {
  const ctx = await setupTest();
  const stream = await openExecStream(ctx.vsockPath, { argv: ['big'], tty: false });

  stream.close();

  const tick = await openExecStream(ctx.vsockPath, { argv: ['tick'], tty: false });

  onTestFinished(() => {
    tick.close();
  });

  expect(tick.pid).toBe(42);
});
