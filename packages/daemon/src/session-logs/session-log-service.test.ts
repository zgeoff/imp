import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResumeFrom, SessionOutput } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import type { AgentSession } from '../agent-client/agent-requests';
import type { ExecEvent, ExecStream } from '../agent-client/exec-stream';
import { readGenerationMeta } from './generation-log';
import { createSessionLogs } from './session-log-service';
import type { SessionLogImp, SessionLogLimits, SessionLogs } from './session-log-service';

type LogsView = Readonly<{ logs: SessionLogs; imp: SessionLogImp }>;

const GEN_A = 'a'.repeat(32);
const GEN_B = 'b'.repeat(32);
const BOOT = 'boot-1';
const dirs: string[] = [];

// each test's services: their open files close before the directories go
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// a tap the test feeds: events wait in a queue until the pump reads them
function createFakeTap(output: SessionOutput) {
  const queue: ExecEvent[] = [];
  const state = { closed: false, ended: false, wake: () => {} };

  const stream: ExecStream = {
    pid: 1,
    session: 'main',
    created: false,
    groupKill: false,
    output,
    writeStdin: () => {},
    stdinDrained: () => Promise.resolve(),
    closeStdin: () => {},
    resize: () => {},
    sendSignal: () => {},
    events: async function* events() {
      for (;;) {
        const event = queue.shift();

        if (event !== undefined) {
          yield event;
          continue;
        }

        if (state.closed || state.ended) {
          return;
        }

        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
      }
    },
    close: () => {
      state.closed = true;

      state.wake();
    },
  };

  return {
    stream,
    state,
    push: (event: ExecEvent) => {
      queue.push(event);
      state.wake();
    },
    write: (text: string) => {
      queue.push({ type: 'stdout', data: new TextEncoder().encode(text) });
      state.wake();
    },

    // the connection drops, as on a sleep's vsock reset
    drop: () => {
      state.ended = true;

      state.wake();
    },
  };
}

type FakeTap = ReturnType<typeof createFakeTap>;

function buildOutput(
  generation: string,
  offset: number,
  extra: Partial<Extract<SessionOutput, { continuity: 'offsets' }>> = {},
): SessionOutput {
  return {
    continuity: 'offsets',
    bootId: BOOT,
    executionGeneration: generation,
    bufferStart: offset,
    end: offset,
    offset,
    prelude: 0,
    coldBoots: [],
    log: { enabled: true },
    ...extra,
  };
}

const LIMITS: SessionLogLimits = {
  generationMaxBytes: 1024,
  impMaxBytes: 4096,
  maxAgeMs: 1000,
};

function setupLogs(
  options: Readonly<{ limits?: SessionLogLimits; dir?: string; full?: boolean }> = {},
) {
  const root = options.dir ?? mkdtempSync(join(tmpdir(), 'imp-session-logs-'));

  if (options.dir === undefined) {
    dirs.push(root);
  }

  const imp: SessionLogImp = {
    id: 'imp-1',
    state: 'running',
    vsockPath: '/nonexistent/vsock.sock',
    sessionLogsDir: join(root, 'session-logs'),
  };

  const clock = { now: 10_000 };
  const calls: { session: string; resumeFrom: ResumeFrom | undefined }[] = [];
  const answers: (FakeTap | Error)[] = [];

  const logs = createSessionLogs({
    limits: options.limits ?? LIMITS,
    requireRoom: () =>
      options.full === true
        ? Promise.reject(new ORPCError('DISK_FULL', { message: 'full' }))
        : Promise.resolve(),
    now: () => clock.now,
    log: () => {},
    openTap: (_vsockPath, session, resumeFrom) => {
      calls.push({ session, resumeFrom });

      const answer = answers.shift();

      if (answer === undefined) {
        return Promise.reject(new Error('no tap scripted'));
      }

      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.stream);
    },
  });

  cleanups.push(() => {
    logs.forgetImp(imp.id);
  });

  return { root, imp, clock, calls, answers, logs };
}

function buildSession(generation: string, log = true): AgentSession {
  return {
    name: 'main',
    pid: 7,
    argv: ['sh'],
    state: 'running',
    attached: false,
    cols: 80,
    rows: 24,
    started_unix_ms: 1,
    execution_generation: generation,
    boot_id: BOOT,
    end: 0,
    ...(log && { log: true }),
  };
}

async function waitFor(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await Bun.sleep(5);
  }
}

function findLog(ctx: LogsView, generation: string) {
  return ctx.logs.listLogs(ctx.imp).find((log) => log.executionGeneration === generation);
}

async function readText(ctx: LogsView, generation: string, from: number) {
  const read = await ctx.logs.readLog(ctx.imp, {
    session: 'main',
    executionGeneration: generation,
    from,
  });

  return { ...read, text: await read.data.text() };
}

test('a logged session is tapped from the ring, and its exit ends the log', async () => {
  const ctx = setupLogs();
  const tap = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(tap);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A), buildSession(GEN_B, false)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  expect(ctx.calls[0]).toEqual({ session: 'main', resumeFrom: undefined });

  tap.write('hello ');
  tap.write('world');
  tap.push({ type: 'exit', code: 3, signal: 0 });

  await waitFor('the end', () => findLog(ctx, GEN_A)?.state === 'ended');

  expect(findLog(ctx, GEN_A)).toMatchObject({
    session: 'main',
    bootId: BOOT,
    logStart: 0,
    logEnd: 11,
    bytes: 11,
    end: 11,
    exitCode: 3,
    complete: true,
  });

  expect(tap.state.closed).toBe(true);

  const read = await readText(ctx, GEN_A, 6);

  expect(read).toMatchObject({ offset: 6, text: 'world' });
  expect(read.gap).toBeUndefined();

  const past = await ctx.logs
    .readLog(ctx.imp, { session: 'main', executionGeneration: GEN_A, from: 12 })
    .catch((error: unknown) => error);

  expect(past).toMatchObject({ code: 'INVALID_RESUME', data: { end: 11, bufferStart: 0 } });

  const missing = await ctx.logs
    .readLog(ctx.imp, { session: 'main', executionGeneration: GEN_B, from: 0 })
    .catch((error: unknown) => error);

  expect(missing).toMatchObject({ code: 'NOT_FOUND' });
});

test('a dropped tap is tapped again from the log end, and a gap leaves a hole', async () => {
  const ctx = setupLogs();
  const first = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(first);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  first.write('abc');

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 3);

  first.drop();

  // the next look taps from 3; the agent's ring has moved on to 10
  const second = createFakeTap(
    buildOutput(GEN_A, 10, { resume: { kind: 'gap', from: 3, to: 10 } }),
  );

  ctx.answers.push(second);

  await waitFor('the tap to go', () => {
    ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

    return ctx.calls.length === 2;
  });

  expect(ctx.calls[1]?.resumeFrom).toEqual({ executionGeneration: GEN_A, offset: 3 });

  second.write('klm');

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 13);

  const hole = await readText(ctx, GEN_A, 3);

  expect(hole).toMatchObject({ offset: 10, gap: { from: 3, to: 10 }, text: 'klm' });
  expect(findLog(ctx, GEN_A)).toMatchObject({ state: 'live', bytes: 6, complete: false });
});

test('a session that is no longer listed ends its log without an end', async () => {
  const ctx = setupLogs();
  const tap = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(tap);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  tap.write('x');

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 1);

  tap.drop();

  await Bun.sleep(20);

  // a cold boot: the new boot lists no such generation
  ctx.logs.observe(ctx.imp, []);

  await waitFor('the end', () => findLog(ctx, GEN_A)?.state === 'ended');

  expect(findLog(ctx, GEN_A)?.end).toBeUndefined();
  expect(findLog(ctx, GEN_A)?.complete).toBe(false);
});

test('NO_SESSION ends the log with the final end the agent kept', async () => {
  const ctx = setupLogs();
  const tap = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(tap);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  tap.write('done');

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 4);

  tap.drop();

  ctx.answers.push(
    new AgentError('NO_SESSION', 'no session "main"', {
      bootId: BOOT,
      coldBoots: [],
      previous: { executionGeneration: GEN_A, end: 4, exitCode: null },
    }),
  );

  await waitFor('the end', () => {
    ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

    return findLog(ctx, GEN_A)?.state === 'ended';
  });

  expect(findLog(ctx, GEN_A)).toMatchObject({ end: 4, exitCode: null, complete: true });
});

test('generation_changed ends the old log and logs the new one from its first offset', async () => {
  const ctx = setupLogs();
  const first = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(first);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  first.write('old');

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 3);

  first.drop();

  const second = createFakeTap(
    buildOutput(GEN_B, 5, {
      resume: { kind: 'generation_changed', executionGeneration: GEN_B, firstOffset: 5 },
      previous: { executionGeneration: GEN_A, end: 3, exitCode: 0 },
    }),
  );

  ctx.answers.push(second);

  await waitFor('the switch', () => {
    ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

    return findLog(ctx, GEN_B) !== undefined;
  });

  second.write('new');

  await waitFor('the bytes', () => findLog(ctx, GEN_B)?.logEnd === 8);

  expect(findLog(ctx, GEN_A)).toMatchObject({ state: 'ended', end: 3, exitCode: 0 });
  expect(findLog(ctx, GEN_B)).toMatchObject({ state: 'live', logStart: 5, logEnd: 8 });
});

test('a deleted live log is never tapped again', async () => {
  const ctx = setupLogs();
  const tap = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(tap);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  tap.write('secret');

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 6);

  expect(ctx.logs.deleteLogs(ctx.imp, { session: 'main' })).toBe(1);
  expect(tap.state.closed).toBe(true);
  expect(ctx.logs.listLogs(ctx.imp)).toEqual([]);

  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await Bun.sleep(20);

  expect(ctx.calls).toHaveLength(1);
  expect(ctx.logs.listLogs(ctx.imp)).toEqual([]);
});

test('a stopped imp ends its logs, and the sweep removes them past their age', async () => {
  const ctx = setupLogs();
  const tap = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(tap);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  tap.write('x');

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 1);

  await ctx.logs.sweep([{ ...ctx.imp, state: 'stopped' }]);

  expect(findLog(ctx, GEN_A)).toMatchObject({ state: 'ended', endedAt: new Date(10_000) });
  expect(tap.state.closed).toBe(true);

  ctx.clock.now += LIMITS.maxAgeMs - 1;

  await ctx.logs.sweep([{ ...ctx.imp, state: 'stopped' }]);

  expect(findLog(ctx, GEN_A)).toBeDefined();

  ctx.clock.now += 2;

  await ctx.logs.sweep([{ ...ctx.imp, state: 'stopped' }]);

  expect(findLog(ctx, GEN_A)).toBeUndefined();
});

test('past the imp limit the oldest ended log goes first', async () => {
  const ctx = setupLogs({ limits: { generationMaxBytes: 1024, impMaxBytes: 1000, maxAgeMs: 1e9 } });
  const first = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(first);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  first.write('a'.repeat(600));
  first.push({ type: 'exit', code: 0, signal: 0 });

  await waitFor('the end', () => findLog(ctx, GEN_A)?.state === 'ended');

  const second = createFakeTap(buildOutput(GEN_B, 0));

  ctx.answers.push(second);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_B)]);

  await waitFor('the tap', () => ctx.calls.length === 2);

  // 600 + 512 is past 1000 once the second log opens its second segment
  second.write('b'.repeat(600));

  await waitFor('the eviction', () => findLog(ctx, GEN_A) === undefined);

  expect(findLog(ctx, GEN_B)?.logEnd).toBe(600);
});

test('a full disk stops the log, and it is not tapped again', async () => {
  const ctx = setupLogs({ full: true });
  const tap = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(tap);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  tap.write('x');

  await waitFor('the stop', () => findLog(ctx, GEN_A)?.stopped === 'disk_full');

  expect(tap.state.closed).toBe(true);

  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await Bun.sleep(20);

  expect(ctx.calls).toHaveLength(1);
});

test('a restarted impd taps a live log on from its end', async () => {
  const ctx = setupLogs();
  const tap = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(tap);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  tap.write('before');

  await waitFor('the commit', () => {
    const meta = readGenerationMeta(join(ctx.imp.sessionLogsDir, GEN_A));

    return meta?.segments[0]?.length === 6;
  });

  // a new impd on the same directory; the old one's files close as a
  // process exit would close them
  ctx.logs.forgetImp(ctx.imp.id);

  const next = setupLogs({ dir: ctx.root });
  const resumed = createFakeTap(buildOutput(GEN_A, 6, { resume: { kind: 'exact' } }));

  next.answers.push(resumed);
  next.logs.observe(next.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => next.calls.length === 1);

  expect(next.calls[0]?.resumeFrom).toEqual({ executionGeneration: GEN_A, offset: 6 });

  resumed.write('+after');

  await waitFor('the bytes', () => findLog(next, GEN_A)?.logEnd === 12);

  const before = await readText(next, GEN_A, 0);
  const after = await readText(next, GEN_A, 6);

  expect(before.text).toBe('before');
  expect(after.text).toBe('+after');
});
