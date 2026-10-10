import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { ResumeFrom } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import type { ExecStream } from '../agent-client/exec-stream';
import { buildMockAgentSession } from '../test-utils/build-mock-agent-session';
import { buildMockSessionOutput } from '../test-utils/build-mock-session-output';
import { buildStubGenerationLogGate } from '../test-utils/build-stub-generation-log-gate';
import { buildStubTapStream } from '../test-utils/build-stub-tap-stream';
import { buildStubTimers } from '../test-utils/build-stub-timers';
import { createGenerationLog, readGenerationMeta } from './generation-log';
import { createSessionLogs } from './session-log-service';
import type { SessionLogImp } from './session-log-service';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const root = await mkdtemp(join(tmpdir(), 'imp-session-logs-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  const calls: { session: string; resumeFrom: ResumeFrom | undefined }[] = [];
  const answers: (() => Promise<ExecStream>)[] = [];
  const looks = { done: 0 };

  return {
    stack,
    root,
    sessionLogsDir: join(root, 'session-logs'),
    timers: buildStubTimers(),
    calls,
    answers,
    looks,

    // the agent's tap: each call takes the next answer the test queued
    openTap: (_vsockPath: string, session: string, resumeFrom?: ResumeFrom) => {
      calls.push({ session, resumeFrom });

      const answer = answers.shift() ?? (() => Promise.reject(new Error('no tap queued')));

      return answer();
    },
    onLookDone: () => {
      looks.done += 1;
    },
  };
}

test('it taps a logged session from the start of its ring', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
    buildMockAgentSession({
      name: 'other',
      execution_generation: 'b'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  expect(ctx.calls).toStrictEqual([{ session: 'main', resumeFrom: undefined }]);
});

test('it ends the log with the final end and exit code when its session exits', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('hello ');
  tap.write('world');
  tap.emitEvent({ type: 'exit', code: 3, signal: 0 });

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.state).toBe('ended');
  });

  expect(logs.listLogs(imp)).toStrictEqual([
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      state: 'ended',
      logStart: 0,
      logEnd: 11,
      bytes: 11,
      end: 11,
      exitCode: 3,
      complete: true,
      startedAt: new Date(10_000),
      endedAt: new Date(10_000),
    },
  ]);

  expect(tap.state.closed).toBe(true);
});

test('it reads the logged bytes from the offset asked for', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('hello world');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(11);
  });

  const read = await logs.readLog(imp, {
    session: 'main',
    executionGeneration: 'a'.repeat(32),
    from: 6,
  });

  const text = await read.data.text();

  expect(read.offset).toBe(6);
  expect(read.gap).toBeUndefined();
  expect(text).toBe('world');
});

test('it rejects a read past the end of the log', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('hello world');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(11);
  });

  expect(
    logs.readLog(imp, { session: 'main', executionGeneration: 'a'.repeat(32), from: 12 }),
  ).rejects.toMatchObject({ code: 'INVALID_RESUME', data: { end: 11, bufferStart: 0 } });
});

test('it rejects a read of a generation it holds no log of', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  expect(
    logs.readLog(imp, { session: 'main', executionGeneration: 'b'.repeat(32), from: 0 }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it taps a dropped tap again from the end of its log', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const first = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(first.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  first.write('abc');
  first.drop();

  await waitFor(() => {
    expect(first.state.finished).toBe(true);
  });

  const second = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 3,
      end: 3,
      offset: 3,
      resume: { kind: 'exact' },
    }),
  );

  ctx.answers.push(() => Promise.resolve(second.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  expect(ctx.calls[1]).toStrictEqual({
    session: 'main',
    resumeFrom: { executionGeneration: 'a'.repeat(32), offset: 3 },
  });
});

test('it leaves a hole for the bytes the ring lost before a tap again', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const first = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(first.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  first.write('abc');
  first.drop();

  await waitFor(() => {
    expect(first.state.finished).toBe(true);
  });

  // the next look taps from 3; the agent's ring has moved on to 10
  const second = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 10,
      end: 10,
      offset: 10,
      resume: { kind: 'gap', from: 3, to: 10 },
    }),
  );

  ctx.answers.push(() => Promise.resolve(second.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  second.write('klm');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(13);
  });

  const hole = await logs.readLog(imp, {
    session: 'main',
    executionGeneration: 'a'.repeat(32),
    from: 3,
  });

  const text = await hole.data.text();

  const [log] = logs.listLogs(imp);

  invariant(log);

  expect(hole.offset).toBe(10);
  expect(hole.gap).toStrictEqual({ from: 3, to: 10 });
  expect(text).toBe('klm');
  expect(log.bytes).toBe(6);
  expect(log.complete).toBe(false);
});

test('it ends the log without a final end when its session is no longer listed', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('x');
  tap.drop();

  await waitFor(() => {
    expect(tap.state.finished).toBe(true);
  });

  // a cold boot: the new boot lists no such generation
  logs.observe(imp, []);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  const [log] = logs.listLogs(imp);

  invariant(log);

  expect(log.state).toBe('ended');
  expect(log.end).toBeUndefined();
  expect(log.complete).toBe(false);
});

test('it ends the log with the final end the agent kept when the session is gone', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('done');
  tap.drop();

  await waitFor(() => {
    expect(tap.state.finished).toBe(true);
  });

  ctx.answers.push(() =>
    Promise.reject(
      new AgentError('NO_SESSION', 'no session "main"', {
        bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        coldBoots: [],
        previous: { executionGeneration: 'a'.repeat(32), end: 4, exitCode: null },
      }),
    ),
  );

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  const [log] = logs.listLogs(imp);

  invariant(log);

  expect(log.state).toBe('ended');
  expect(log.end).toBe(4);
  expect(log.exitCode).toBeNull();
  expect(log.complete).toBe(true);
});

test('it ends the old log and logs the next generation from its first offset when the generation changed', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const first = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(first.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  first.write('old');
  first.drop();

  await waitFor(() => {
    expect(first.state.finished).toBe(true);
  });

  const second = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 5,
      end: 5,
      offset: 5,
      resume: { kind: 'generation_changed', executionGeneration: 'b'.repeat(32), firstOffset: 5 },
      previous: { executionGeneration: 'a'.repeat(32), end: 3, exitCode: 0 },
    }),
  );

  ctx.answers.push(() => Promise.resolve(second.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  second.write('new');

  await waitFor(() => {
    expect(
      logs.listLogs(imp).find((log) => log.executionGeneration === 'b'.repeat(32))?.logEnd,
    ).toBe(8);
  });

  const old = logs.listLogs(imp).find((log) => log.executionGeneration === 'a'.repeat(32));
  const next = logs.listLogs(imp).find((log) => log.executionGeneration === 'b'.repeat(32));

  invariant(old);
  invariant(next);

  expect(old.state).toBe('ended');
  expect(old.end).toBe(3);
  expect(old.exitCode).toBe(0);
  expect(next.state).toBe('live');
  expect(next.logStart).toBe(5);
  expect(next.logEnd).toBe(8);
});

test('it closes the tap and removes the log when a live log is deleted', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('secret');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(6);
  });

  const count = logs.deleteLogs(imp, { session: 'main' });

  expect(count).toBe(1);
  expect(tap.state.closed).toBe(true);
  expect(logs.listLogs(imp)).toStrictEqual([]);
});

test('it never taps a deleted live log again', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  logs.deleteLogs(imp, { session: 'main' });

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  expect(ctx.calls).toHaveLength(1);
  expect(logs.listLogs(imp)).toStrictEqual([]);
});

test("it never deletes another session's log or another imp's logs", async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const neighbour: SessionLogImp = {
    id: 'imp-2',
    state: 'running',
    vsockPath: '/nonexistent/vsock-2.sock',
    sessionLogsDir: join(ctx.root, 'imp-2-session-logs'),
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const planted = await Promise.all(
    [
      {
        dir: join(imp.sessionLogsDir, 'a'.repeat(32)),
        session: 'main',
        generation: 'a'.repeat(32),
      },
      {
        dir: join(imp.sessionLogsDir, 'b'.repeat(32)),
        session: 'other',
        generation: 'b'.repeat(32),
      },
      {
        dir: join(neighbour.sessionLogsDir, 'c'.repeat(32)),
        session: 'main',
        generation: 'c'.repeat(32),
      },
    ].map((each) =>
      createGenerationLog(
        {
          dir: each.dir,
          segmentBytes: 512,
          maxBytes: 1024,
          requireRoom: () => Promise.resolve(),
          now: () => 9000,
          log: () => {},
          startTimer: ctx.timers.startTimer,
        },
        {
          session: each.session,
          executionGeneration: each.generation,
          bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        },
      ),
    ),
  );

  ctx.stack.defer(() => {
    for (const log of planted) {
      log.abandon();
    }
  });

  await Promise.all(planted.map((log) => log.finish({ end: 0, exitCode: 0 })));

  const count = logs.deleteLogs(imp, { session: 'main' });

  expect(count).toBe(1);
  expect(readdirSync(imp.sessionLogsDir)).toStrictEqual(['b'.repeat(32)]);
  expect(readdirSync(neighbour.sessionLogsDir)).toStrictEqual(['c'.repeat(32)]);
});

test('it ends the live logs of a stopped imp when it sweeps', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  await logs.sweep([{ ...imp, state: 'stopped' }]);

  const [log] = logs.listLogs(imp);

  invariant(log);

  expect(log.state).toBe('ended');
  expect(log.endedAt).toStrictEqual(new Date(10_000));
  expect(tap.state.closed).toBe(true);
});

test('it keeps an ended log until it is past its age when it sweeps', async () => {
  const ctx = await setupTest();

  const clock = { now: 10_000 };

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'stopped',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => clock.now,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const planted = await createGenerationLog(
    {
      dir: join(imp.sessionLogsDir, 'a'.repeat(32)),
      segmentBytes: 512,
      maxBytes: 1024,
      requireRoom: () => Promise.resolve(),
      now: () => 10_000,
      log: () => {},
      startTimer: ctx.timers.startTimer,
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    planted.abandon();
  });

  await planted.finish({ end: 0, exitCode: 0 });

  clock.now = 10_000 + 999;

  await logs.sweep([imp]);

  expect(readdirSync(imp.sessionLogsDir)).toStrictEqual(['a'.repeat(32)]);
});

test('it removes an ended log past its age when it sweeps', async () => {
  const ctx = await setupTest();

  const clock = { now: 10_000 };

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'stopped',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => clock.now,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const planted = await createGenerationLog(
    {
      dir: join(imp.sessionLogsDir, 'a'.repeat(32)),
      segmentBytes: 512,
      maxBytes: 1024,
      requireRoom: () => Promise.resolve(),
      now: () => 10_000,
      log: () => {},
      startTimer: ctx.timers.startTimer,
    },
    {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    planted.abandon();
  });

  await planted.finish({ end: 0, exitCode: 0 });

  clock.now = 10_000 + 1001;

  await logs.sweep([imp]);

  expect(readdirSync(imp.sessionLogsDir)).toStrictEqual([]);
});

test('it never sweeps a live log, a young ended log, or the logs of an imp it was not given', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const neighbour: SessionLogImp = {
    id: 'imp-2',
    state: 'stopped',
    vsockPath: '/nonexistent/vsock-2.sock',
    sessionLogsDir: join(ctx.root, 'imp-2-session-logs'),
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 100_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  // a live log as old as the rest, an ended one younger than the age, one
  // past it, and one past it of the other imp
  const planted = await Promise.all(
    [
      { dir: join(imp.sessionLogsDir, 'a'.repeat(32)), generation: 'a'.repeat(32), at: 1000 },
      { dir: join(imp.sessionLogsDir, 'b'.repeat(32)), generation: 'b'.repeat(32), at: 99_500 },
      { dir: join(imp.sessionLogsDir, 'c'.repeat(32)), generation: 'c'.repeat(32), at: 1000 },
      { dir: join(neighbour.sessionLogsDir, 'd'.repeat(32)), generation: 'd'.repeat(32), at: 1000 },
    ].map((each) =>
      createGenerationLog(
        {
          dir: each.dir,
          segmentBytes: 512,
          maxBytes: 1024,
          requireRoom: () => Promise.resolve(),
          now: () => each.at,
          log: () => {},
          startTimer: ctx.timers.startTimer,
        },
        {
          session: 'main',
          executionGeneration: each.generation,
          bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        },
      ),
    ),
  );

  ctx.stack.defer(() => {
    for (const log of planted) {
      log.abandon();
    }
  });

  await Promise.all(planted.slice(1).map((log) => log.finish({ end: 0, exitCode: 0 })));
  await logs.sweep([imp]);

  expect(readdirSync(imp.sessionLogsDir).toSorted()).toStrictEqual([
    'a'.repeat(32),
    'b'.repeat(32),
  ]);

  expect(readdirSync(neighbour.sessionLogsDir)).toStrictEqual(['d'.repeat(32)]);
});

// both orders of name, so a removal in directory order fails one of them
test.each([
  ['the later name', 'c'.repeat(32), 'a'.repeat(32)],
  ['the earlier name', 'a'.repeat(32), 'c'.repeat(32)],
])(
  'it removes the oldest ended log first once the imp passes its limit, when that log has %s',
  async (_label, olderGeneration, newerGeneration) => {
    const ctx = await setupTest();

    const imp: SessionLogImp = {
      id: 'imp-1',
      state: 'running',
      vsockPath: '/nonexistent/vsock.sock',
      sessionLogsDir: ctx.sessionLogsDir,
    };

    const clock = { now: 10_000 };

    const logs = createSessionLogs({
      limits: { generationMaxBytes: 1024, impMaxBytes: 1000, impMaxLive: 8, maxAgeMs: 1e9 },
      requireRoom: () => Promise.resolve(),
      now: () => clock.now,
      log: () => {},
      startTimer: ctx.timers.startTimer,
      openTap: ctx.openTap,
      onLookDone: ctx.onLookDone,
    });

    ctx.stack.defer(() => {
      logs.forgetImp(imp.id);
    });

    const older = buildStubTapStream(
      buildMockSessionOutput({
        executionGeneration: olderGeneration,
        bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        bufferStart: 0,
        end: 0,
        offset: 0,
      }),
    );

    ctx.answers.push(() => Promise.resolve(older.stream));

    logs.observe(imp, [
      buildMockAgentSession({
        name: 'main',
        execution_generation: olderGeneration,
        boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        log: true,
      }),
    ]);

    await waitFor(() => {
      expect(ctx.looks.done).toBe(1);
    });

    older.write('o'.repeat(300));
    older.emitEvent({ type: 'exit', code: 0, signal: 0 });

    await waitFor(() => {
      expect(
        logs.listLogs(imp).find((log) => log.executionGeneration === olderGeneration)?.state,
      ).toBe('ended');
    });

    clock.now = 20_000;

    const newer = buildStubTapStream(
      buildMockSessionOutput({
        executionGeneration: newerGeneration,
        bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        bufferStart: 0,
        end: 0,
        offset: 0,
      }),
    );

    ctx.answers.push(() => Promise.resolve(newer.stream));

    logs.observe(imp, [
      buildMockAgentSession({
        name: 'main',
        execution_generation: newerGeneration,
        boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        log: true,
      }),
    ]);

    await waitFor(() => {
      expect(ctx.looks.done).toBe(2);
    });

    newer.write('n'.repeat(300));
    newer.emitEvent({ type: 'exit', code: 0, signal: 0 });

    await waitFor(() => {
      expect(
        logs.listLogs(imp).find((log) => log.executionGeneration === newerGeneration)?.state,
      ).toBe('ended');
    });

    clock.now = 30_000;

    const second = buildStubTapStream(
      buildMockSessionOutput({
        executionGeneration: 'b'.repeat(32),
        bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        bufferStart: 0,
        end: 0,
        offset: 0,
      }),
    );

    ctx.answers.push(() => Promise.resolve(second.stream));

    logs.observe(imp, [
      buildMockAgentSession({
        name: 'main',
        execution_generation: 'b'.repeat(32),
        boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        log: true,
      }),
    ]);

    await waitFor(() => {
      expect(ctx.looks.done).toBe(3);
    });

    // 300 + 300 + 600 is past 1000; without the older log it is 900
    second.write('b'.repeat(600));

    await waitFor(() => {
      expect(
        logs.listLogs(imp).find((log) => log.executionGeneration === olderGeneration),
      ).toBeUndefined();
    });

    expect(logs.listLogs(imp).map((log) => log.executionGeneration)).toIncludeSameMembers([
      newerGeneration,
      'b'.repeat(32),
    ]);

    expect(
      logs.listLogs(imp).find((log) => log.executionGeneration === 'b'.repeat(32))?.logEnd,
    ).toBe(600);
  },
);

test('it stops the log for a full disk and closes its tap', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.reject(new ORPCError('DISK_FULL', { message: 'full' })),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('x');

  await waitFor(() => {
    expect(tap.state.finished).toBe(true);
  });

  expect(logs.listLogs(imp)[0]?.stopped).toBe('disk_full');
  expect(tap.state.closed).toBe(true);
});

test('it never taps a log that stopped for a full disk again', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.reject(new ORPCError('DISK_FULL', { message: 'full' })),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('x');

  await waitFor(() => {
    expect(tap.state.finished).toBe(true);
  });

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  expect(ctx.calls).toHaveLength(1);
});

test('it taps a live log on from its end after impd restarts', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('before');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(6);
  });

  ctx.timers.firePending();

  const logDir = join(imp.sessionLogsDir, 'a'.repeat(32));

  await waitFor(() => {
    expect(readGenerationMeta(logDir)?.segments).toStrictEqual([{ start: 0, length: 6 }]);
  });

  // a new impd on the same directory; the old one's files close as a
  // process exit would close them
  logs.forgetImp(imp.id);

  const restarted = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    restarted.forgetImp(imp.id);
  });

  const resumed = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 6,
      offset: 6,
      resume: { kind: 'exact' },
    }),
  );

  ctx.answers.push(() => Promise.resolve(resumed.stream));

  restarted.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  expect(ctx.calls[1]).toStrictEqual({
    session: 'main',
    resumeFrom: { executionGeneration: 'a'.repeat(32), offset: 6 },
  });
});

test('it keeps the bytes from before an impd restart in the log it goes on with', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  tap.write('before');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(6);
  });

  ctx.timers.firePending();

  const logDir = join(imp.sessionLogsDir, 'a'.repeat(32));

  await waitFor(() => {
    expect(readGenerationMeta(logDir)?.segments).toStrictEqual([{ start: 0, length: 6 }]);
  });

  logs.forgetImp(imp.id);

  const restarted = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    restarted.forgetImp(imp.id);
  });

  const resumed = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 6,
      offset: 6,
      resume: { kind: 'exact' },
    }),
  );

  ctx.answers.push(() => Promise.resolve(resumed.stream));

  restarted.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  resumed.write('+after');

  await waitFor(() => {
    expect(restarted.listLogs(imp)[0]?.logEnd).toBe(12);
  });

  const before = await restarted.readLog(imp, {
    session: 'main',
    executionGeneration: 'a'.repeat(32),
    from: 0,
  });

  const after = await restarted.readLog(imp, {
    session: 'main',
    executionGeneration: 'a'.repeat(32),
    from: 6,
  });

  const beforeText = await before.data.text();
  const afterText = await after.data.text();

  expect(beforeText).toBe('before');
  expect(afterText).toBe('+after');
});

test.each([
  ['a slash', '/'],
  ['a backslash', '\\'],
  ['a path with a slash', 'a/b'],
  ['a path with a backslash', String.raw`a\b`],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative escape', '../../../evil'],
  ['a relative escape with backslashes', String.raw`..\..\evil`],
  ['an absolute path', '/etc/passwd'],
  ['a drive path', String.raw`C:\evil`],
  ['a NUL', '\0'],
  ['a name holding a NUL', 'a\0b'],
  ['a 4096-character name', 'x'.repeat(4096)],
  ['an empty name', ''],
  ['31 hex digits and a slash', `${'a'.repeat(31)}/`],
  ['31 hex digits and a backslash', `${'a'.repeat(31)}\\`],
  ['hex digits that climb out and back', `${'a'.repeat(16)}/../${'a'.repeat(13)}`],
  ['31 hex digits after a slash', `/${'a'.repeat(31)}`],
  ['31 hex digits and a NUL', `${'a'.repeat(31)}\0`],
  ['31 hex digits', 'a'.repeat(31)],
  ['33 hex digits', 'a'.repeat(33)],
  ['32 uppercase hex digits', 'A'.repeat(32)],
  ['32 letters past f', 'g'.repeat(32)],
  ['a boot id', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
])('it refuses a read of %s as a generation it holds no log of', async (_label, generation) => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  expect(
    logs.readLog(imp, { session: 'main', executionGeneration: generation, from: 0 }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it touches neither the disk nor the agent for a session with a hostile generation', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const generations = [
    '/',
    '\\',
    'a/b',
    String.raw`a\b`,
    '..',
    '.',
    '../../../evil',
    String.raw`..\..\evil`,
    '/etc/passwd',
    String.raw`C:\evil`,
    '\0',
    'a\0b',
    'x'.repeat(4096),
    '',
    `${'a'.repeat(31)}/`,
    `${'a'.repeat(31)}\\`,
    `${'a'.repeat(16)}/../${'a'.repeat(13)}`,
    `/${'a'.repeat(31)}`,
    `${'a'.repeat(31)}\0`,
    'a'.repeat(31),
    'a'.repeat(33),
    'A'.repeat(32),
    'g'.repeat(32),
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ];

  // every place a hostile value could name: none may appear or go
  const targets = generations
    .filter((value) => !value.includes('\0'))
    .flatMap((value) => [
      resolvePath(ctx.sessionLogsDir, value),
      resolvePath(ctx.sessionLogsDir, value, 'meta.json'),
      resolvePath(ctx.sessionLogsDir, '.deleted', value),
    ]);

  const before = targets.filter((path) => existsSync(path));

  const sessions = generations.map((generation) =>
    buildMockAgentSession({
      name: 'main',
      execution_generation: generation,
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  );

  logs.observe(imp, sessions);

  for (const session of sessions) {
    logs.tapNow(imp, session);
  }

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1 + sessions.length);
  });

  expect(ctx.calls).toStrictEqual([]);
  expect(readdirSync(ctx.root)).toStrictEqual([]);
  expect(targets.filter((path) => existsSync(path))).toStrictEqual(before);
});

test('it touches neither the disk nor the agent for a session with a hostile boot id', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const bootIds = [
    '/',
    '\\',
    'a/b',
    String.raw`a\b`,
    '..',
    '.',
    '../../../evil',
    String.raw`..\..\evil`,
    '/etc/passwd',
    String.raw`C:\evil`,
    '\0',
    'a\0b',
    'x'.repeat(4096),
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1/',
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1\\',
    '../c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11\0',
    'f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d110',
    '4F3C0F86-8F8B-4C45-A3B4-8E1C1E9B0D11',
    '4g3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    '4f3c0f868f8b4c45a3b48e1c1e9b0d11',
  ];

  const targets = bootIds
    .filter((value) => !value.includes('\0'))
    .flatMap((value) => [
      resolvePath(ctx.sessionLogsDir, value),
      resolvePath(ctx.sessionLogsDir, value, 'meta.json'),
      resolvePath(ctx.sessionLogsDir, '.deleted', value),
    ]);

  const before = targets.filter((path) => existsSync(path));

  const sessions = bootIds.map((bootId) =>
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: bootId,
      log: true,
    }),
  );

  logs.observe(imp, sessions);

  for (const session of sessions) {
    logs.tapNow(imp, session);
  }

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1 + sessions.length);
  });

  expect(ctx.calls).toStrictEqual([]);
  expect(readdirSync(ctx.root)).toStrictEqual([]);
  expect(targets.filter((path) => existsSync(path))).toStrictEqual(before);
});

test('it touches neither the disk nor the agent for a session with a hostile name', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const names = [
    '/',
    '\\',
    'a/b',
    String.raw`a\b`,
    '..',
    '.',
    '../../../evil',
    String.raw`..\..\evil`,
    '/etc/passwd',
    String.raw`C:\evil`,
    '\0',
    'a\0b',
    'x'.repeat(4096),
    '',
    'main/..',
    String.raw`main\x`,
    'main\0',
    'a'.repeat(33),
    'Main',
    '-main',
    'main.log',
  ];

  const targets = names
    .filter((value) => !value.includes('\0'))
    .flatMap((value) => [
      resolvePath(ctx.sessionLogsDir, value),
      resolvePath(ctx.sessionLogsDir, value, 'meta.json'),
      resolvePath(ctx.sessionLogsDir, '.deleted', value),
    ]);

  const before = targets.filter((path) => existsSync(path));

  const sessions = names.map((name) =>
    buildMockAgentSession({
      name,
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  );

  logs.observe(imp, sessions);

  for (const session of sessions) {
    logs.tapNow(imp, session);
  }

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1 + sessions.length);
  });

  expect(ctx.calls).toStrictEqual([]);
  expect(readdirSync(ctx.root)).toStrictEqual([]);
  expect(targets.filter((path) => existsSync(path))).toStrictEqual(before);
});

test.each([
  ['a slash as its generation', '/', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a backslash as its generation', '\\', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a path with a slash as its generation', 'a/b', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  [
    'a path with a backslash as its generation',
    String.raw`a\b`,
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  ['the parent directory as its generation', '..', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['the current directory as its generation', '.', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a relative escape as its generation', '../../../evil', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  [
    'a relative escape with backslashes as its generation',
    String.raw`..\..\evil`,
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  ['an absolute path as its generation', '/etc/hostname', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a drive path as its generation', String.raw`C:\evil`, '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a NUL as its generation', '\0', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a name holding a NUL as its generation', 'a\0b', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  [
    'a 4096-character name as its generation',
    'x'.repeat(4096),
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  ['an empty name as its generation', '', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  [
    '31 hex digits and a slash as its generation',
    `${'a'.repeat(31)}/`,
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  [
    '31 hex digits and a backslash as its generation',
    `${'a'.repeat(31)}\\`,
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  [
    'hex digits that climb out and back as its generation',
    `${'a'.repeat(16)}/../${'a'.repeat(13)}`,
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  [
    '31 hex digits after a slash as its generation',
    `/${'a'.repeat(31)}`,
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  [
    '31 hex digits and a NUL as its generation',
    `${'a'.repeat(31)}\0`,
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  ['31 hex digits as its generation', 'a'.repeat(31), '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['33 hex digits as its generation', 'a'.repeat(33), '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  [
    '32 uppercase hex digits as its generation',
    'A'.repeat(32),
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  ['32 letters past f as its generation', 'g'.repeat(32), '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  [
    'a boot id as its generation',
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  ],
  ['a slash as its boot id', 'b'.repeat(32), '/'],
  ['a backslash as its boot id', 'b'.repeat(32), '\\'],
  ['a path with a slash as its boot id', 'b'.repeat(32), 'a/b'],
  ['a path with a backslash as its boot id', 'b'.repeat(32), String.raw`a\b`],
  ['the parent directory as its boot id', 'b'.repeat(32), '..'],
  ['the current directory as its boot id', 'b'.repeat(32), '.'],
  ['a relative escape as its boot id', 'b'.repeat(32), '../../../evil'],
  ['a relative escape with backslashes as its boot id', 'b'.repeat(32), String.raw`..\..\evil`],
  ['an absolute path as its boot id', 'b'.repeat(32), '/etc/passwd'],
  ['a drive path as its boot id', 'b'.repeat(32), String.raw`C:\evil`],
  ['a NUL as its boot id', 'b'.repeat(32), '\0'],
  ['a name holding a NUL as its boot id', 'b'.repeat(32), 'a\0b'],
  ['a 4096-character name as its boot id', 'b'.repeat(32), 'x'.repeat(4096)],
  ['a boot id ending in a slash', 'b'.repeat(32), '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1/'],
  ['a boot id ending in a backslash', 'b'.repeat(32), '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1\\'],
  ['a boot id that climbs out', 'b'.repeat(32), '../c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a boot id and a NUL', 'b'.repeat(32), '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11\0'],
  ['a boot id one character short', 'b'.repeat(32), 'f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a boot id one character long', 'b'.repeat(32), '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d110'],
  ['an uppercase boot id', 'b'.repeat(32), '4F3C0F86-8F8B-4C45-A3B4-8E1C1E9B0D11'],
  ['a boot id with a letter past f', 'b'.repeat(32), '4g3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a boot id without its dashes', 'b'.repeat(32), '4f3c0f868f8b4c45a3b48e1c1e9b0d11'],
])(
  'it closes a changed-generation tap that names %s and makes nothing',
  async (_label, generation, bootId) => {
    const ctx = await setupTest();

    const imp: SessionLogImp = {
      id: 'imp-1',
      state: 'running',
      vsockPath: '/nonexistent/vsock.sock',
      sessionLogsDir: ctx.sessionLogsDir,
    };

    const logs = createSessionLogs({
      limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
      requireRoom: () => Promise.resolve(),
      now: () => 10_000,
      log: () => {},
      startTimer: ctx.timers.startTimer,
      openTap: ctx.openTap,
      onLookDone: ctx.onLookDone,
    });

    ctx.stack.defer(() => {
      logs.forgetImp(imp.id);
    });

    const first = buildStubTapStream(
      buildMockSessionOutput({
        executionGeneration: 'a'.repeat(32),
        bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        bufferStart: 0,
        end: 0,
        offset: 0,
      }),
    );

    ctx.answers.push(() => Promise.resolve(first.stream));

    logs.observe(imp, [
      buildMockAgentSession({
        name: 'main',
        execution_generation: 'a'.repeat(32),
        boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        log: true,
      }),
    ]);

    await waitFor(() => {
      expect(ctx.looks.done).toBe(1);
    });

    first.write('old');
    first.drop();

    await waitFor(() => {
      expect(first.state.finished).toBe(true);
    });

    const targets = [
      resolvePath(ctx.sessionLogsDir, generation),
      resolvePath(ctx.sessionLogsDir, generation, 'meta.json'),
      resolvePath(ctx.sessionLogsDir, '.deleted', generation),
      resolvePath(ctx.sessionLogsDir, bootId),
      resolvePath(ctx.sessionLogsDir, bootId, 'meta.json'),
      resolvePath(ctx.sessionLogsDir, '.deleted', bootId),
    ];

    const before = targets.filter((path) => existsSync(path));

    const forged = buildStubTapStream(
      buildMockSessionOutput({
        executionGeneration: generation,
        bootId,
        bufferStart: 5,
        end: 5,
        offset: 5,
        resume: { kind: 'generation_changed', executionGeneration: generation, firstOffset: 5 },
        previous: { executionGeneration: 'a'.repeat(32), end: 3, exitCode: 0 },
      }),
    );

    ctx.answers.push(() => Promise.resolve(forged.stream));

    logs.observe(imp, [
      buildMockAgentSession({
        name: 'main',
        execution_generation: 'a'.repeat(32),
        boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        log: true,
      }),
    ]);

    await waitFor(() => {
      expect(ctx.looks.done).toBe(2);
    });

    expect(forged.state.closed).toBe(true);
    expect(readdirSync(ctx.sessionLogsDir)).toStrictEqual(['a'.repeat(32)]);
    expect(logs.listLogs(imp)[0]?.state).toBe('live');
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(3);
    expect(targets.filter((path) => existsSync(path))).toStrictEqual(before);
  },
);

test('it lists no log for a meta on disk that names another generation', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  mkdirSync(join(imp.sessionLogsDir, 'a'.repeat(32)), { recursive: true });

  writeFileSync(
    join(imp.sessionLogsDir, 'a'.repeat(32), 'meta.json'),
    JSON.stringify({
      version: 1,
      session: 'main',
      executionGeneration: '../../evil',
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      startedAt: 1,
      origin: 0,
      segments: [],
      state: 'live',
    }),
  );

  expect(logs.listLogs(imp)).toStrictEqual([]);
});

test('it leaves a directory alone whose meta names another generation', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  mkdirSync(join(imp.sessionLogsDir, 'a'.repeat(32)), { recursive: true });

  writeFileSync(
    join(imp.sessionLogsDir, 'a'.repeat(32), 'meta.json'),
    JSON.stringify({
      version: 1,
      session: 'main',
      executionGeneration: '../../evil',
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      startedAt: 1,
      origin: 0,
      segments: [],
      state: 'live',
    }),
  );

  logs.observe(imp, []);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  const logDir = join(imp.sessionLogsDir, 'a'.repeat(32));

  expect(readdirSync(logDir)).toStrictEqual(['meta.json']);
  expect(readdirSync(imp.sessionLogsDir)).toStrictEqual(['a'.repeat(32)]);
});

test('it logs at most its cap of generations for a forged agent that lists many', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const generations = Array.from({ length: 30 }, (_, index) =>
    index.toString(16).padStart(32, '0'),
  );

  ctx.answers.push(
    ...generations.map((generation) => {
      const tap = buildStubTapStream(
        buildMockSessionOutput({
          executionGeneration: generation,
          bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
          bufferStart: 0,
          end: 0,
          offset: 0,
        }),
      );

      return () => Promise.resolve(tap.stream);
    }),
  );

  logs.observe(
    imp,
    generations.map((generation) =>
      buildMockAgentSession({
        name: 'main',
        execution_generation: generation,
        boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        log: true,
      }),
    ),
  );

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  expect(logs.listLogs(imp)).toHaveLength(8);
  expect(ctx.calls).toHaveLength(8);
});

test('it keeps the imp under its limit while its logs roll past their first segment', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  // 512-byte segments: a log at its own bound adds one as it drops one
  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const generations = Array.from({ length: 8 }, (_, index) => index.toString(16).padStart(32, '0'));

  const feeds = generations.map((generation) =>
    buildStubTapStream(
      buildMockSessionOutput({
        executionGeneration: generation,
        bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        bufferStart: 0,
        end: 0,
        offset: 0,
      }),
    ),
  );

  ctx.answers.push(...feeds.map((feed) => () => Promise.resolve(feed.stream)));

  logs.observe(
    imp,
    generations.map((generation) =>
      buildMockAgentSession({
        name: 'main',
        execution_generation: generation,
        boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        log: true,
      }),
    ),
  );

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  // six rounds of a segment to each log: before the fix, a log at its own
  // bound rolled with no check, and the imp grew to twice its limit
  for (let round = 1; round <= 6; round += 1) {
    for (const feed of feeds) {
      feed.write('x'.repeat(512));
    }
  }

  for (const feed of feeds) {
    feed.drop();
  }

  await waitFor(() => {
    expect(feeds.map((feed) => feed.state.finished)).toSatisfyAll(
      (isFinished: boolean) => isFinished,
    );
  });

  const kept = readdirSync(imp.sessionLogsDir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.seg'))
    .reduce((sum, path) => sum + Bun.file(join(imp.sessionLogsDir, path)).size, 0);

  expect(kept).toBeLessThanOrEqual(4096);
});

test('it keeps the imp under its limit while a log grows within one segment', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  // 1024-byte segments: the growth below never starts a new one
  const logs = createSessionLogs({
    limits: { generationMaxBytes: 2048, impMaxBytes: 1000, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const ended = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(ended.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  ended.write('e'.repeat(900));
  ended.emitEvent({ type: 'exit', code: 0, signal: 0 });

  await waitFor(() => {
    expect(ended.state.finished).toBe(true);
  });

  const growing = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(growing.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'b'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  // one byte starts the segment; ten pieces of 30 grow it
  growing.write('g');

  for (let piece = 0; piece < 10; piece += 1) {
    growing.write('g'.repeat(30));
  }

  growing.emitEvent({ type: 'exit', code: 0, signal: 0 });

  await waitFor(() => {
    expect(growing.state.finished).toBe(true);
  });

  await logs.sweep([imp]);

  const kept = readdirSync(imp.sessionLogsDir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.seg'))
    .reduce((sum, path) => sum + Bun.file(join(imp.sessionLogsDir, path)).size, 0);

  expect(kept).toBeLessThanOrEqual(1000);
  expect(logs.listLogs(imp).map((log) => log.executionGeneration)).toStrictEqual(['b'.repeat(32)]);
});

test('it stops the newest live log once only live logs keep the imp past its limit', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 200, impMaxBytes: 150, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const first = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  const second = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(first.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  first.write('a'.repeat(100));

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(100);
  });

  ctx.answers.push(() => Promise.resolve(second.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
    buildMockAgentSession({
      name: 'other',
      execution_generation: 'b'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  // segments of 100: each log holds one, and together they pass 150
  second.write('b'.repeat(100));

  await waitFor(() => {
    expect(second.state.finished).toBe(true);
  });

  const older = logs.listLogs(imp).find((log) => log.executionGeneration === 'a'.repeat(32));
  const newer = logs.listLogs(imp).find((log) => log.executionGeneration === 'b'.repeat(32));

  invariant(older);
  invariant(newer);

  expect(newer.stopped).toBe('imp_limit');
  expect(second.state.closed).toBe(true);
  expect(older.stopped).toBeUndefined();
});

test('it never taps a log that stopped at the imp limit again', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 200, impMaxBytes: 150, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const first = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  const second = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(
    () => Promise.resolve(first.stream),
    () => Promise.resolve(second.stream),
  );

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  first.write('a'.repeat(100));

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(100);
  });

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
    buildMockAgentSession({
      name: 'other',
      execution_generation: 'b'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  second.write('b'.repeat(100));

  await waitFor(() => {
    expect(second.state.finished).toBe(true);
  });

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
    buildMockAgentSession({
      name: 'other',
      execution_generation: 'b'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(3);
  });

  expect(ctx.calls).toHaveLength(2);
});

test('it leaves no directory behind for a log being made when the imp is destroyed', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.tapNow(imp, {
    name: 'main',
    execution_generation: 'a'.repeat(32),
    boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  });

  // the destroy: forget, then remove the imp's directory
  logs.forgetImp(imp.id);

  rmSync(imp.sessionLogsDir, { recursive: true, force: true });

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  expect(existsSync(imp.sessionLogsDir)).toBe(false);
  expect(ctx.calls).toStrictEqual([]);
});

test('it writes nothing for work from before a destroy once the imp is moved home', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  // a tap on its way when the imp is destroyed, then moved home at once
  logs.tapNow(imp, {
    name: 'main',
    execution_generation: 'a'.repeat(32),
    boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  });

  logs.forgetImp(imp.id);

  rmSync(imp.sessionLogsDir, { recursive: true, force: true });

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'b'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  logs.admitImp(imp.id);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  expect(ctx.calls).toStrictEqual([]);
  expect(existsSync(imp.sessionLogsDir)).toBe(false);
});

test('it logs again for an imp moved home under its id after a destroy', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  logs.tapNow(imp, {
    name: 'main',
    execution_generation: 'a'.repeat(32),
    boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  });

  logs.forgetImp(imp.id);

  rmSync(imp.sessionLogsDir, { recursive: true, force: true });

  logs.admitImp(imp.id);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.tapNow(imp, {
    name: 'main',
    execution_generation: 'b'.repeat(32),
    boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  });

  tap.write('home');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(4);
  });

  expect(logs.listLogs(imp).map((log) => log.executionGeneration)).toStrictEqual(['b'.repeat(32)]);
});

test.each([
  ['the same generation', 'a'.repeat(32), undefined, undefined],
  [
    'a changed generation',
    'b'.repeat(32),
    { kind: 'generation_changed', executionGeneration: 'b'.repeat(32), firstOffset: 0 } as const,
    { executionGeneration: 'a'.repeat(32), end: 3, exitCode: 0 },
  ],
])(
  'it writes nothing from a tap of %s from before a destroy that opens once the imp is back',
  async (_label, generation, resume, previous) => {
    const ctx = await setupTest();

    const imp: SessionLogImp = {
      id: 'imp-1',
      state: 'running',
      vsockPath: '/nonexistent/vsock.sock',
      sessionLogsDir: ctx.sessionLogsDir,
    };

    const logs = createSessionLogs({
      limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
      requireRoom: () => Promise.resolve(),
      now: () => 10_000,
      log: () => {},
      startTimer: ctx.timers.startTimer,
      openTap: ctx.openTap,
      onLookDone: ctx.onLookDone,
    });

    ctx.stack.defer(() => {
      logs.forgetImp(imp.id);
    });

    // life 0 asks for a tap that answers only once the imp is back
    const opened = Promise.withResolvers<ExecStream>();

    ctx.answers.push(() => opened.promise);

    logs.observe(imp, [
      buildMockAgentSession({
        name: 'main',
        execution_generation: 'a'.repeat(32),
        boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        log: true,
      }),
    ]);

    await waitFor(() => {
      expect(ctx.calls).toHaveLength(1);
    });

    logs.forgetImp(imp.id);

    rmSync(imp.sessionLogsDir, { recursive: true, force: true });

    logs.admitImp(imp.id);

    // life 1, a warm move home: the same generation
    const current = buildStubTapStream(
      buildMockSessionOutput({
        executionGeneration: 'a'.repeat(32),
        bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        bufferStart: 0,
        end: 0,
        offset: 0,
      }),
    );

    ctx.answers.push(() => Promise.resolve(current.stream));

    logs.observe(imp, [
      buildMockAgentSession({
        name: 'main',
        execution_generation: 'a'.repeat(32),
        boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        log: true,
      }),
    ]);

    current.write('new');

    await waitFor(() => {
      expect(logs.listLogs(imp)[0]?.logEnd).toBe(3);
    });

    const old = buildStubTapStream(
      buildMockSessionOutput({
        executionGeneration: generation,
        bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
        bufferStart: 0,
        end: 0,
        offset: 0,
        ...(resume !== undefined && { resume }),
        ...(previous !== undefined && { previous }),
      }),
    );

    old.write('old');
    opened.resolve(old.stream);

    await waitFor(() => {
      expect(ctx.looks.done).toBe(2);
    });

    current.write('+more');

    await waitFor(() => {
      expect(logs.listLogs(imp)[0]?.logEnd).toBe(8);
    });

    const read = await logs.readLog(imp, {
      session: 'main',
      executionGeneration: 'a'.repeat(32),
      from: 0,
    });

    const text = await read.data.text();

    expect(old.state.closed).toBe(true);
    expect(text).toBe('new+more');
    expect(logs.listLogs(imp)[0]?.state).toBe('live');
    expect(readdirSync(imp.sessionLogsDir)).toStrictEqual(['a'.repeat(32)]);
  },
);

test('it opens no second tap when a tap from before a destroy fails once the imp is back', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const opened = Promise.withResolvers<ExecStream>();

  ctx.answers.push(() => opened.promise);

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.calls).toHaveLength(1);
  });

  logs.forgetImp(imp.id);

  rmSync(imp.sessionLogsDir, { recursive: true, force: true });

  logs.admitImp(imp.id);

  const current = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(current.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  opened.reject(
    new AgentError('NO_SESSION', 'no session "main"', {
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      coldBoots: [],
      previous: { executionGeneration: 'a'.repeat(32), end: 0, exitCode: 0 },
    }),
  );

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(3);
  });

  current.write('new');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(3);
  });

  expect(ctx.calls).toHaveLength(2);
  expect(current.state.closed).toBe(false);
  expect(logs.listLogs(imp)[0]?.state).toBe('live');
});

test("it still ends the new life's log once its session is gone after a tap from before a destroy failed", async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const opened = Promise.withResolvers<ExecStream>();

  ctx.answers.push(() => opened.promise);

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.calls).toHaveLength(1);
  });

  logs.forgetImp(imp.id);

  rmSync(imp.sessionLogsDir, { recursive: true, force: true });

  logs.admitImp(imp.id);

  const current = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(current.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  opened.reject(
    new AgentError('NO_SESSION', 'no session "main"', {
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      coldBoots: [],
      previous: { executionGeneration: 'a'.repeat(32), end: 0, exitCode: 0 },
    }),
  );

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  current.drop();

  await waitFor(() => {
    expect(current.state.finished).toBe(true);
  });

  logs.observe(imp, []);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(3);
  });

  expect(logs.listLogs(imp)[0]?.state).toBe('ended');
});

test("it frees no slot of the imp's next life for a log made across a destroy and a move home", async () => {
  const ctx = await setupTest();

  const gate = buildStubGenerationLogGate({ operation: 'create', call: 1 });

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
    createLog: gate.createLog,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  // life 0's log waits to be made across the destroy
  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await gate.reached;

  logs.forgetImp(imp.id);

  rmSync(imp.sessionLogsDir, { recursive: true, force: true });

  logs.admitImp(imp.id);

  // life 1, a move home under the same id, with the same generation
  const current = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(current.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  current.write('new');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(3);
  });

  gate.release();

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  current.write('+more');

  await waitFor(() => {
    expect(ctx.looks.done).toBe(3);
  });

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(8);
  });

  const [log] = logs.listLogs(imp);

  invariant(log);

  const closedBeforeDestroy = current.state.closed;

  // a destroy closes the tap only while the new life still holds its slot
  logs.forgetImp(imp.id);

  expect(ctx.calls).toHaveLength(1);
  expect(closedBeforeDestroy).toBe(false);
  expect(log.state).toBe('live');
  expect(log.stopped).toBeUndefined();
  expect(current.state.closed).toBe(true);
});

test("it stops no log of the imp's next life for a limit check held across a destroy and a move home", async () => {
  const ctx = await setupTest();

  const gate = buildStubGenerationLogGate({ operation: 'removeOldestSegment', call: 1 });

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 2048, impMaxBytes: 100, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
    createLog: gate.createLog,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const first = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(first.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  // past the limit in one segment: the check waits on its removal
  first.write('x'.repeat(200));

  await gate.reached;

  logs.forgetImp(imp.id);

  rmSync(imp.sessionLogsDir, { recursive: true, force: true });

  logs.admitImp(imp.id);

  const current = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(current.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  current.write('new');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(3);
  });

  gate.release();

  // life 0's pump has finished its held check
  await waitFor(() => {
    expect(first.state.finished).toBe(true);
  });

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(3);
  });

  current.write('+more');

  await waitFor(() => {
    expect(logs.listLogs(imp)[0]?.logEnd).toBe(8);
  });

  const [log] = logs.listLogs(imp);

  invariant(log);

  const closedBeforeDestroy = current.state.closed;

  // a destroy closes the tap only while the new life still holds its slot
  logs.forgetImp(imp.id);

  expect(ctx.calls).toHaveLength(2);
  expect(closedBeforeDestroy).toBe(false);
  expect(log.state).toBe('live');
  expect(log.stopped).toBeUndefined();
  expect(current.state.closed).toBe(true);
});

test("it removes none of the imp's next life's logs for a limit check from before a destroy", async () => {
  const ctx = await setupTest();

  const gate = buildStubGenerationLogGate({ operation: 'append', call: 2 });

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 2048, impMaxBytes: 100, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
    createLog: gate.createLog,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const first = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(first.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  // life 0's second append waits until the imp is back
  first.write('a');
  first.write('x'.repeat(200));

  await gate.reached;

  logs.forgetImp(imp.id);

  rmSync(imp.sessionLogsDir, { recursive: true, force: true });

  logs.admitImp(imp.id);

  // the next life holds an ended log past the limit, as one moved home with it would
  const planted = await createGenerationLog(
    {
      dir: join(imp.sessionLogsDir, 'b'.repeat(32)),
      segmentBytes: 1024,
      maxBytes: 2048,
      requireRoom: () => Promise.resolve(),
      now: () => 1,
      log: () => {},
      startTimer: ctx.timers.startTimer,
    },
    {
      session: 'main',
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  ctx.stack.defer(() => {
    planted.abandon();
  });

  await planted.append(new TextEncoder().encode('p'.repeat(150)));
  await planted.finish({ end: 150, exitCode: 0 });

  gate.release();

  // life 0's pump has finished the append and its limit check
  await waitFor(() => {
    expect(first.state.finished).toBe(true);
  });

  const plantedMeta = join(imp.sessionLogsDir, 'b'.repeat(32), 'meta.json');

  expect(existsSync(plantedMeta)).toBe(true);
});

test('it closes the tap of a next generation whose log cannot be made', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const first = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(first.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  first.drop();

  await waitFor(() => {
    expect(first.state.finished).toBe(true);
  });

  // a file where the next generation's log directory goes: making it fails
  writeFileSync(join(imp.sessionLogsDir, 'b'.repeat(32)), '');

  const switched = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
      resume: { kind: 'generation_changed', executionGeneration: 'b'.repeat(32), firstOffset: 0 },
      previous: { executionGeneration: 'a'.repeat(32), end: 0, exitCode: 0 },
    }),
  );

  ctx.answers.push(() => Promise.resolve(switched.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  expect(switched.state.closed).toBe(true);

  expect(
    logs.listLogs(imp).find((log) => log.executionGeneration === 'b'.repeat(32)),
  ).toBeUndefined();
});

test('it taps a next generation again at the next look once its log can be made', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const first = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(first.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  first.drop();

  await waitFor(() => {
    expect(first.state.finished).toBe(true);
  });

  writeFileSync(join(imp.sessionLogsDir, 'b'.repeat(32)), '');

  const switched = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
      resume: { kind: 'generation_changed', executionGeneration: 'b'.repeat(32), firstOffset: 0 },
      previous: { executionGeneration: 'a'.repeat(32), end: 0, exitCode: 0 },
    }),
  );

  ctx.answers.push(() => Promise.resolve(switched.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  // the fault clears: the next look taps the generation again
  rmSync(join(imp.sessionLogsDir, 'b'.repeat(32)));

  const retried = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(retried.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'b'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(3);
  });

  expect(ctx.calls).toHaveLength(3);

  expect(logs.listLogs(imp).find((log) => log.executionGeneration === 'b'.repeat(32))?.state).toBe(
    'live',
  );
});

test('it never taps a deleted live log again after impd restarts', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  logs.deleteLogs(imp, { session: 'main' });
  logs.forgetImp(imp.id);

  const restarted = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    restarted.forgetImp(imp.id);
  });

  restarted.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  expect(ctx.calls).toHaveLength(1);
  expect(restarted.listLogs(imp)).toStrictEqual([]);
});

test('it removes the tombstone of a deleted generation once the agent no longer lists it', async () => {
  const ctx = await setupTest();

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: ctx.sessionLogsDir,
  };

  const logs = createSessionLogs({
    limits: { generationMaxBytes: 1024, impMaxBytes: 4096, impMaxLive: 8, maxAgeMs: 1000 },
    requireRoom: () => Promise.resolve(),
    now: () => 10_000,
    log: () => {},
    startTimer: ctx.timers.startTimer,
    openTap: ctx.openTap,
    onLookDone: ctx.onLookDone,
  });

  ctx.stack.defer(() => {
    logs.forgetImp(imp.id);
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'a'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.answers.push(() => Promise.resolve(tap.stream));

  logs.observe(imp, [
    buildMockAgentSession({
      name: 'main',
      execution_generation: 'a'.repeat(32),
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(1);
  });

  logs.deleteLogs(imp, { session: 'main' });

  const tombstone = join(imp.sessionLogsDir, '.deleted', 'a'.repeat(32));
  const isMarkedBefore = existsSync(tombstone);

  logs.observe(imp, []);

  await waitFor(() => {
    expect(ctx.looks.done).toBe(2);
  });

  expect(isMarkedBefore).toBe(true);
  expect(existsSync(tombstone)).toBe(false);
});
