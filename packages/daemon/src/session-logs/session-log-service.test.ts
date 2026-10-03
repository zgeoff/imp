import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { ResumeFrom, SessionOutput } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import type { AgentSession } from '../agent-client/agent-requests';
import type { ExecEvent, ExecStream } from '../agent-client/exec-stream';
import {
  HOSTILE_BOOT_IDS,
  HOSTILE_GENERATIONS,
  HOSTILE_SESSION_NAMES,
} from '../agent-client/test-agent-ids';
import { readGenerationMeta } from './generation-log';
import { createSessionLogs } from './session-log-service';
import type { SessionLogImp, SessionLogLimits, SessionLogs } from './session-log-service';

type LogsView = Readonly<{ logs: SessionLogs; imp: SessionLogImp }>;

const GEN_A = 'a'.repeat(32);
const GEN_B = 'b'.repeat(32);
const BOOT = '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11';
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
  impMaxLive: 8,
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
  const answers: (FakeTap | Error | Promise<FakeTap>)[] = [];

  const logs = createSessionLogs({
    limits: options.limits ?? LIMITS,
    requireRoom: () =>
      options.full === true
        ? Promise.reject(new ORPCError('DISK_FULL', { message: 'full' }))
        : Promise.resolve(),
    now: () => clock.now,
    log: () => {},

    // the restart case waits for a flush; it need not wait a second
    commitDelayMs: 10,
    openTap: (_vsockPath, session, resumeFrom) => {
      calls.push({ session, resumeFrom });

      const answer = answers.shift();

      if (answer === undefined) {
        return Promise.reject(new Error('no tap scripted'));
      }

      if (answer instanceof Promise) {
        return answer.then((tap) => tap.stream);
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
  const ctx = setupLogs({ limits: { ...LIMITS, impMaxBytes: 1000, maxAgeMs: 1e9 } });
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

// whether each place a hostile value could name exists: it must not change
function findTargets(ctx: LogsView, values: readonly string[]) {
  return values
    .filter((value) => !value.includes('\0'))
    .flatMap((value) => [
      resolvePath(ctx.imp.sessionLogsDir, value),
      resolvePath(ctx.imp.sessionLogsDir, value, 'meta.json'),
      resolvePath(ctx.imp.sessionLogsDir, '.deleted', value),
    ])
    .map((path) => ({ path, exists: existsSync(path) }));
}

const HOSTILE_SESSIONS = [
  ...HOSTILE_GENERATIONS.map((value) => ({ ...buildSession(GEN_A), execution_generation: value })),
  ...HOSTILE_BOOT_IDS.map((value) => ({ ...buildSession(GEN_A), boot_id: value })),
  ...HOSTILE_SESSION_NAMES.map((value) => ({ ...buildSession(GEN_A), name: value })),
];

const HOSTILE_VALUES = [...HOSTILE_GENERATIONS, ...HOSTILE_BOOT_IDS, ...HOSTILE_SESSION_NAMES];

test('a hostile generation, boot id or session name touches neither the disk nor the agent', async () => {
  const ctx = setupLogs();
  const before = findTargets(ctx, HOSTILE_VALUES);
  const errors: unknown[] = [];

  ctx.logs.observe(ctx.imp, HOSTILE_SESSIONS);

  for (const session of HOSTILE_SESSIONS) {
    ctx.logs.tapNow(ctx.imp, session);
  }

  for (const generation of HOSTILE_GENERATIONS) {
    const refused = await ctx.logs
      .readLog(ctx.imp, { session: 'main', executionGeneration: generation, from: 0 })
      .catch((error: unknown) => error);

    errors.push(refused);
  }

  await Bun.sleep(50);

  expect(ctx.calls).toEqual([]);
  expect(readdirSync(ctx.root, { recursive: true })).toEqual([]);
  expect(findTargets(ctx, HOSTILE_VALUES)).toEqual(before);

  expect(
    errors.filter((error) => !(error instanceof ORPCError && error.code === 'NOT_FOUND')),
  ).toEqual([]);
});

test('a generation_changed tap that names a hostile next generation ends and makes nothing', async () => {
  const ctx = setupLogs();
  const first = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(first);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  first.write('old');

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 3);

  first.drop();

  const forged = [
    ...HOSTILE_GENERATIONS.map((generation) => ({ generation, bootId: BOOT })),
    ...HOSTILE_BOOT_IDS.map((bootId) => ({ generation: GEN_B, bootId })),
  ];

  const before = findTargets(ctx, [...HOSTILE_GENERATIONS, ...HOSTILE_BOOT_IDS, GEN_B]);

  for (const forgery of forged) {
    const next = createFakeTap(
      buildOutput(forgery.generation, 5, {
        bootId: forgery.bootId,
        resume: {
          kind: 'generation_changed',
          executionGeneration: forgery.generation,
          firstOffset: 5,
        },
        previous: { executionGeneration: GEN_A, end: 3, exitCode: 0 },
      }),
    );

    ctx.answers.push(next);

    await waitFor('the refusal', () => {
      ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

      return next.state.closed;
    });
  }

  expect(readdirSync(ctx.imp.sessionLogsDir)).toEqual([GEN_A]);
  expect(findLog(ctx, GEN_A)).toMatchObject({ state: 'live', logEnd: 3 });
  expect(findTargets(ctx, [...HOSTILE_GENERATIONS, ...HOSTILE_BOOT_IDS, GEN_B])).toEqual(before);
});

test('a meta on disk that names another generation is not read', async () => {
  const ctx = setupLogs();
  const dir = join(ctx.imp.sessionLogsDir, GEN_A);

  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      session: 'main',
      executionGeneration: '../../evil',
      bootId: BOOT,
      startedAt: 1,
      origin: 0,
      segments: [],
      state: 'live',
    }),
  );

  expect(ctx.logs.listLogs(ctx.imp)).toEqual([]);

  ctx.logs.observe(ctx.imp, []);

  await Bun.sleep(20);

  expect(readdirSync(ctx.imp.sessionLogsDir)).toEqual([GEN_A]);
});

test('a forged agent that lists many logged generations gets at most the cap of logs', async () => {
  const ctx = setupLogs();

  const generations = Array.from({ length: 30 }, (_, index) =>
    index.toString(16).padStart(32, '0'),
  );

  ctx.answers.push(...generations.map(() => createFakeTap(buildOutput(GEN_A, 0))));

  ctx.logs.observe(
    ctx.imp,
    generations.map((generation) => buildSession(generation)),
  );

  await Bun.sleep(50);

  expect(ctx.logs.listLogs(ctx.imp)).toHaveLength(LIMITS.impMaxLive);
  expect(ctx.calls).toHaveLength(LIMITS.impMaxLive);
});

test('logs that roll past their first segment still keep the imp under its limit', async () => {
  // 512-byte segments: a log at its own bound adds one as it drops one
  const limits = { ...LIMITS, generationMaxBytes: 1024, impMaxBytes: 4096 };
  const ctx = setupLogs({ limits });

  const generations = Array.from({ length: LIMITS.impMaxLive }, (_, index) =>
    index.toString(16).padStart(32, '0'),
  );

  const feeds = generations.map((generation) => createFakeTap(buildOutput(generation, 0)));

  // one at a time, so each feed taps its own generation
  for (const [index, feed] of feeds.entries()) {
    ctx.answers.push(feed);

    ctx.logs.observe(
      ctx.imp,
      generations.slice(0, index + 1).map((generation) => buildSession(generation)),
    );

    await waitFor('the tap', () => ctx.calls.length === index + 1);
  }

  const countDiskBytes = () =>
    readdirSync(ctx.imp.sessionLogsDir, { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('.seg'))
      .reduce((sum, path) => sum + Bun.file(join(ctx.imp.sessionLogsDir, path)).size, 0);

  // each write settles under the limit: before the fix, a log at its own
  // bound rolled with no check, and the imp grew to twice its limit
  for (let round = 1; round <= 6; round += 1) {
    for (const [index, feed] of feeds.entries()) {
      feed.write('x'.repeat(512));

      await waitFor('the bytes', () => {
        const log = findLog(ctx, generations[index] ?? '');

        return log === undefined || log.stopped !== undefined || log.logEnd === round * 512;
      });

      await waitFor('the limit', () => countDiskBytes() <= limits.impMaxBytes);
    }
  }

  expect(countDiskBytes()).toBeLessThanOrEqual(limits.impMaxBytes);
});

test('past the imp limit with only live logs left, the newest stops with imp_limit', async () => {
  const ctx = setupLogs({ limits: { ...LIMITS, generationMaxBytes: 200, impMaxBytes: 150 } });
  const first = createFakeTap(buildOutput(GEN_A, 0));
  const second = createFakeTap(buildOutput(GEN_B, 0));

  ctx.answers.push(first);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  first.write('a'.repeat(100));

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 100);

  ctx.answers.push(second);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A), buildSession(GEN_B)]);

  await waitFor('the tap', () => ctx.calls.length === 2);

  // segments of 100: each log holds one, and together they pass 150
  second.write('b'.repeat(100));

  await waitFor('the stop', () => findLog(ctx, GEN_B)?.stopped === 'imp_limit');

  expect(second.state.closed).toBe(true);
  expect(findLog(ctx, GEN_A)?.stopped).toBeUndefined();

  ctx.logs.observe(ctx.imp, [buildSession(GEN_A), buildSession(GEN_B)]);

  await Bun.sleep(20);

  expect(ctx.calls).toHaveLength(2);
});

test('a destroy while a log is being made leaves no directory behind', async () => {
  const ctx = setupLogs();

  ctx.answers.push(createFakeTap(buildOutput(GEN_A, 0)));
  ctx.logs.tapNow(ctx.imp, { name: 'main', execution_generation: GEN_A, boot_id: BOOT });

  // the destroy: forget, then remove the imp's directory
  ctx.logs.forgetImp(ctx.imp.id);

  rmSync(ctx.imp.sessionLogsDir, { recursive: true, force: true });

  await Bun.sleep(50);

  expect(existsSync(ctx.imp.sessionLogsDir)).toBe(false);
  expect(ctx.calls).toEqual([]);
});

test('a destroyed imp moved home under its id logs again, and old work writes nothing', async () => {
  const ctx = setupLogs();

  // a tap on its way when the imp is destroyed, then moved home at once
  ctx.answers.push(createFakeTap(buildOutput(GEN_A, 0)));
  ctx.logs.tapNow(ctx.imp, { name: 'main', execution_generation: GEN_A, boot_id: BOOT });
  ctx.logs.forgetImp(ctx.imp.id);

  rmSync(ctx.imp.sessionLogsDir, { recursive: true, force: true });

  ctx.logs.observe(ctx.imp, [buildSession(GEN_B)]);
  ctx.logs.admitImp(ctx.imp.id);

  await Bun.sleep(50);

  expect(ctx.calls).toEqual([]);
  expect(existsSync(ctx.imp.sessionLogsDir)).toBe(false);

  const tap = createFakeTap(buildOutput(GEN_B, 0));

  ctx.answers.length = 0;

  ctx.answers.push(tap);
  ctx.logs.tapNow(ctx.imp, { name: 'main', execution_generation: GEN_B, boot_id: BOOT });

  await waitFor('the tap', () => ctx.calls.length === 1);

  tap.write('home');

  await waitFor('the bytes', () => findLog(ctx, GEN_B)?.logEnd === 4);

  expect(ctx.logs.listLogs(ctx.imp).map((log) => log.executionGeneration)).toEqual([GEN_B]);
});

test('a tap from before a destroy that opens after the imp is back writes nothing', async () => {
  for (const late of ['same', 'generation_changed'] as const) {
    const ctx = setupLogs();
    const opened = Promise.withResolvers<FakeTap>();

    // life 0 asks for a tap that answers only once the imp is back
    ctx.answers.push(opened.promise);
    ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

    await waitFor('the first tap', () => ctx.calls.length === 1);

    ctx.logs.forgetImp(ctx.imp.id);

    rmSync(ctx.imp.sessionLogsDir, { recursive: true, force: true });

    ctx.logs.admitImp(ctx.imp.id);

    // life 1, a warm move home: the same generation
    const current = createFakeTap(buildOutput(GEN_A, 0));

    ctx.answers.push(current);
    ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

    await waitFor('the second tap', () => ctx.calls.length === 2);

    current.write('new');

    await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 3);

    const lateOutput =
      late === 'same'
        ? buildOutput(GEN_A, 0)
        : buildOutput(GEN_B, 0, {
            resume: { kind: 'generation_changed', executionGeneration: GEN_B, firstOffset: 0 },
            previous: { executionGeneration: GEN_A, end: 3, exitCode: 0 },
          });

    const old = createFakeTap(lateOutput);

    old.write('old');
    opened.resolve(old);

    await waitFor('the old tap closed', () => old.state.closed);

    current.write('+more');

    await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 8);

    const read = await readText(ctx, GEN_A, 0);

    expect(read.text).toBe('new+more');
    expect(findLog(ctx, GEN_A)).toMatchObject({ state: 'live' });
    expect(readdirSync(ctx.imp.sessionLogsDir)).toEqual([GEN_A]);
  }
});

test('a tap from before a destroy that fails after the imp is back leaves the new tap alone', async () => {
  const ctx = setupLogs();
  const opened = Promise.withResolvers<FakeTap>();

  ctx.answers.push(opened.promise);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the first tap', () => ctx.calls.length === 1);

  ctx.logs.forgetImp(ctx.imp.id);

  rmSync(ctx.imp.sessionLogsDir, { recursive: true, force: true });

  ctx.logs.admitImp(ctx.imp.id);

  const current = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(current);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the second tap', () => ctx.calls.length === 2);

  opened.reject(
    new AgentError('NO_SESSION', 'no session "main"', {
      bootId: BOOT,
      coldBoots: [],
      previous: { executionGeneration: GEN_A, end: 0, exitCode: 0 },
    }),
  );

  await Bun.sleep(20);

  // the new life's log and tap keep their slots: no second tap opens, and
  // the log still ends once its session is gone
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await Bun.sleep(20);

  current.write('new');

  await waitFor('the bytes', () => findLog(ctx, GEN_A)?.logEnd === 3);

  expect(ctx.calls).toHaveLength(2);

  current.drop();

  await waitFor('the end', () => {
    ctx.logs.observe(ctx.imp, []);

    return findLog(ctx, GEN_A)?.state === 'ended';
  });
});

test('a deleted live log is not tapped again by a restarted impd', async () => {
  const ctx = setupLogs();
  const tap = createFakeTap(buildOutput(GEN_A, 0));

  ctx.answers.push(tap);
  ctx.logs.observe(ctx.imp, [buildSession(GEN_A)]);

  await waitFor('the tap', () => ctx.calls.length === 1);

  expect(ctx.logs.deleteLogs(ctx.imp, { session: 'main' })).toBe(1);

  ctx.logs.forgetImp(ctx.imp.id);

  const next = setupLogs({ dir: ctx.root });

  next.answers.push(createFakeTap(buildOutput(GEN_A, 0)));
  next.logs.observe(next.imp, [buildSession(GEN_A)]);

  await Bun.sleep(30);

  expect(next.calls).toEqual([]);
  expect(next.logs.listLogs(next.imp)).toEqual([]);

  // once the generation is gone, so is its tombstone
  next.logs.observe(next.imp, []);

  await waitFor(
    'the tombstone to go',
    () => !existsSync(join(next.imp.sessionLogsDir, '.deleted', GEN_A)),
  );
});
