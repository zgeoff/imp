import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRejection } from '../read-rejection';
import { sendActivity, sendPing, sendSessionKill } from './agent-requests';
import { openAttachStream, openExecStream, openTapStream } from './exec-stream';
import type { ExecEvent, ExecStream } from './exec-stream';
import { startFakeAgent } from './fake-agent';
import type { FakeAgentHandler } from './fake-agent';
import { FRAME_TYPES, decodeJsonPayload, encodeFrame, encodeJsonFrame } from './frame-codec';
import { HOSTILE_BOOT_IDS, HOSTILE_GENERATIONS, HOSTILE_SESSION_NAMES } from './test-agent-ids';

// a fake agent in a fresh directory
async function setupFakeVsock(agent: FakeAgentHandler) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vsock-'));
  const path = join(dir, 'vsock.sock');

  const fake = await startFakeAgent(path, agent);

  return {
    path,
    received: fake.received,
    [Symbol.dispose]() {
      fake.close();

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function collectEvents(stream: ExecStream) {
  const collected: ExecEvent[] = [];

  for await (const event of stream.events()) {
    collected.push(event);
  }

  return collected;
}

test('it pings through the CONNECT handshake', async () => {
  using vsock = await setupFakeVsock((socket, request) => {
    expect(decodeJsonPayload(request)).toEqual({ op: 'ping' });

    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true, version: '0.1.0', uptime_ms: 5 }));
  });

  const ping = await sendPing(vsock.path);

  expect(ping).toEqual({ ok: true, version: '0.1.0', uptime_ms: 5 });
});

test('it streams an exec: stdin in, output and exit out', async () => {
  using vsock = await setupFakeVsock((socket, _request, frames) => {
    const last = frames.at(-1);

    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
    } else if (last?.type === FRAME_TYPES.stdin) {
      socket.write(encodeFrame(FRAME_TYPES.stdout, last.payload));
    } else if (last?.type === FRAME_TYPES.stdinEof) {
      socket.write(encodeFrame(FRAME_TYPES.stderr, new TextEncoder().encode('bye')));
      socket.end(encodeJsonFrame(FRAME_TYPES.exit, { code: 3, signal: 0 }));
    }
  });

  const stream = await openExecStream(vsock.path, { argv: ['cat'], tty: false });

  stream.writeStdin(new TextEncoder().encode('hi'));
  stream.closeStdin();

  const events = await collectEvents(stream);

  expect(stream.pid).toBe(42);

  expect(events).toEqual([
    { type: 'stdout', data: new TextEncoder().encode('hi') },
    { type: 'stderr', data: new TextEncoder().encode('bye') },
    { type: 'exit', code: 3, signal: 0 },
  ]);

  expect(decodeJsonPayload(vsock.received[0] ?? { type: 0, payload: new Uint8Array() })).toEqual({
    op: 'exec',
    argv: ['cat'],
    tty: false,
  });
});

test('it rejects with the agent error when exec cannot start', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'EXEC_FAILED', message: 'start nope: no such file' },
      }),
    );
  });

  const opening = openExecStream(vsock.path, { argv: ['nope'], tty: false });

  const error = await readRejection(opening);

  expect(error).toMatchObject({ code: 'EXEC_FAILED' });
});

test('it refuses a handshake the agent does not accept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vsock-'));
  const path = join(dir, 'vsock.sock');

  const server = createServer((socket) => {
    socket.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  try {
    const error = await readRejection(sendPing(path, 500));

    expect(error).toBeInstanceOf(Error);
  } finally {
    server.close();

    rmSync(dir, { recursive: true, force: true });
  }
});

test('an exec fails and closes its connection when STARTED never comes', async () => {
  const closed = Promise.withResolvers<void>();

  using vsock = await setupFakeVsock((socket) => {
    socket.on('close', () => {
      closed.resolve();
    });
  });

  const rejection = await openExecStream(vsock.path, { argv: ['sleep'], tty: false }, 50).catch(
    (error: unknown) => error,
  );

  expect(rejection).toMatchObject({ message: 'agent did not answer within 50 ms' });

  await closed.promise;
});

test('it attaches to a session: STARTED, the replay, then detached', async () => {
  using vsock = await setupFakeVsock((socket, _request, frames) => {
    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, session: 'main' }));
      socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('replay')));
      socket.end(encodeJsonFrame(FRAME_TYPES.detached, { reason: 'taken_over' }));
    }
  });

  const stream = await openAttachStream(vsock.path, { session: 'main', cols: 80, rows: 24 });
  const events = await collectEvents(stream);

  // an agent from before offsets: the replay as before
  expect(stream).toMatchObject({
    pid: 42,
    session: 'main',
    created: false,
    output: { continuity: 'none' },
  });

  expect(events).toEqual([
    { type: 'stdout', data: new TextEncoder().encode('replay') },
    { type: 'detached', reason: 'taken_over' },
  ]);

  expect(decodeJsonPayload(vsock.received[0] ?? { type: 0, payload: new Uint8Array() })).toEqual({
    op: 'session.attach',
    session: 'main',
    cols: 80,
    rows: 24,
  });
});

test('a resume goes to the agent in its shape, without wake, and STARTED places the data', async () => {
  const generation = 'e'.repeat(32);

  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 42,
        session: 'main',
        output: {
          boot_id: '11111111-1111-4111-8111-111111111111',
          execution_generation: generation,
          buffer_start: 10,
          end: 20,
          offset: 10,
          prelude: 0,
          resume: { kind: 'gap', from: 4, to: 10 },
        },
      }),
    );
  });

  const stream = await openAttachStream(vsock.path, {
    session: 'main',
    resumeFrom: { executionGeneration: generation, offset: 4 },
    wake: false,
  });

  stream.close();

  expect(decodeJsonPayload(vsock.received[0] ?? { type: 0, payload: new Uint8Array() })).toEqual({
    op: 'session.attach',
    session: 'main',
    resume_from: { execution_generation: generation, offset: 4 },
  });

  expect(stream.output).toEqual({
    continuity: 'offsets',
    bootId: '11111111-1111-4111-8111-111111111111',
    executionGeneration: generation,
    bufferStart: 10,
    end: 20,
    offset: 10,
    prelude: 0,
    coldBoots: [],
    resume: { kind: 'gap', from: 4, to: 10 },
  });
});

test('a session request to an agent from before sessions fails', async () => {
  const closed = Promise.withResolvers<void>();

  using vsock = await setupFakeVsock((socket) => {
    socket.on('close', () => {
      closed.resolve();
    });

    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  const opening = openExecStream(vsock.path, { argv: ['sh'], tty: true, session: 'main' });

  const error = await readRejection(opening);

  expect(error).toMatchObject({ code: 'AGENT_OUTDATED' });

  await closed.promise;
});

test('a plain exec stream has no session', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  const stream = await openExecStream(vsock.path, { argv: ['true'], tty: false });

  expect(stream).toMatchObject({ session: null, created: false });

  stream.close();
});

test('activity from an agent before sessions lists none', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, { tcp_established: 0, exec_sessions: 0, load1: 0 }),
    );
  });

  const activity = await sendActivity(vsock.path);

  expect(activity.sessions).toEqual([]);
});

test('a kill of no session rejects with NO_SESSION', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'NO_SESSION', message: 'no session "main"' },
      }),
    );
  });

  const error = await readRejection(sendSessionKill(vsock.path, 'main'));

  expect(error).toMatchObject({ code: 'NO_SESSION' });
});

test('an attach or a kill on an agent from before sessions fails as AGENT_OUTDATED', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op' },
      }),
    );
  });

  const attach = await readRejection(openAttachStream(vsock.path, { session: 'main' }));
  const kill = await readRejection(sendSessionKill(vsock.path, 'main'));

  expect([attach, kill]).toMatchObject([{ code: 'AGENT_OUTDATED' }, { code: 'AGENT_OUTDATED' }]);
});

test('a kill grace goes to the agent, and its echo arms the group kill', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, kill_grace_ms: 2000 }));
  });

  const stream = await openExecStream(vsock.path, {
    argv: ['sleep', '9'],
    tty: false,
    killGraceMs: 2000,
  });

  expect(
    decodeJsonPayload(vsock.received[0] ?? { type: 0, payload: new Uint8Array() }),
  ).toMatchObject({ op: 'exec', kill_grace_ms: 2000 });

  expect(stream.groupKill).toBe(true);

  stream.close();
});

// an agent from before 0.8.0 ignores the field and does not echo it, so the
// host keeps cleaning up the group itself
test('an old agent leaves the group kill off', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  const stream = await openExecStream(vsock.path, {
    argv: ['sleep', '9'],
    tty: false,
    killGraceMs: 2000,
  });

  expect(stream.groupKill).toBe(false);

  stream.close();
});

test('without a kill grace the request carries none', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  const stream = await openExecStream(vsock.path, { argv: ['true'], tty: false });

  expect(
    decodeJsonPayload(vsock.received[0] ?? { type: 0, payload: new Uint8Array() }),
  ).not.toHaveProperty('kill_grace_ms');

  expect(stream.groupKill).toBe(false);

  stream.close();
});

test('an outer exec is the exec.outer op, which an older agent refuses as AGENT_OUTDATED', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op exec.outer' },
      }),
    );
  });

  const rejection = await openExecStream(vsock.path, {
    argv: ['ls', '/user'],
    tty: false,
    outer: true,
  }).catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'AGENT_OUTDATED' });

  expect(decodeJsonPayload(vsock.received[0] ?? { type: 0, payload: new Uint8Array() })).toEqual({
    op: 'exec.outer',
    argv: ['ls', '/user'],
    tty: false,
  });
});

test('a tap is the session.tap op, and a logged STARTED says the log is on', async () => {
  const generation = 'e'.repeat(32);

  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 42,
        session: 'main',
        output: {
          boot_id: '11111111-1111-4111-8111-111111111111',
          execution_generation: generation,
          buffer_start: 0,
          end: 9,
          offset: 9,
          prelude: 0,
          resume: { kind: 'exact' },
          log: true,
        },
      }),
    );
  });

  const stream = await openTapStream(vsock.path, 'main', {
    executionGeneration: generation,
    offset: 9,
  });

  stream.close();

  expect(decodeJsonPayload(vsock.received[0] ?? { type: 0, payload: new Uint8Array() })).toEqual({
    op: 'session.tap',
    session: 'main',
    resume_from: { execution_generation: generation, offset: 9 },
  });

  expect(stream.output).toMatchObject({ offset: 9, log: { enabled: true } });
});

test('a tap on an agent from before session logs fails as AGENT_OUTDATED', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op' },
      }),
    );
  });

  const tap = await readRejection(openTapStream(vsock.path, 'main'));

  expect(tap).toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('activity drops a session whose generation, boot or name is not of its form', async () => {
  const good = {
    name: 'main',
    pid: 1,
    argv: ['sh'],
    state: 'running',
    attached: false,
    cols: 80,
    rows: 24,
    started_unix_ms: 1,
    execution_generation: 'a'.repeat(32),
    boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    log: true,
  };

  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        tcp_established: 0,
        exec_sessions: 0,
        load1: 0,
        sessions: [
          good,
          ...HOSTILE_GENERATIONS.map((value) => ({ ...good, execution_generation: value })),
          ...HOSTILE_BOOT_IDS.map((value) => ({ ...good, boot_id: value })),
          ...HOSTILE_SESSION_NAMES.map((value) => ({ ...good, name: value })),
        ],
      }),
    );
  });

  const activity = await sendActivity(vsock.path);

  expect(activity.sessions.map((session) => session.execution_generation)).toEqual([
    'a'.repeat(32),
  ]);
});

test('a tap whose STARTED names a forged generation, boot id or session fails', async () => {
  const output = {
    boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    execution_generation: 'a'.repeat(32),
    buffer_start: 0,
    end: 0,
    offset: 0,
    prelude: 0,
    log: true,
  };

  const forged = [
    ...HOSTILE_GENERATIONS.map((value) => ({
      session: 'main',
      output: { ...output, execution_generation: value },
    })),
    ...HOSTILE_BOOT_IDS.map((value) => ({
      session: 'main',
      output: { ...output, boot_id: value },
    })),
    ...HOSTILE_SESSION_NAMES.map((value) => ({ session: value, output })),
  ];

  const opened: unknown[] = [];

  // the real STARTED opens, so each refusal below is its forged value's
  for (const started of [{ session: 'main', output }, ...forged]) {
    using vsock = await setupFakeVsock((socket) => {
      socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, ...started }));
    });

    const stream = await openTapStream(vsock.path, 'main').catch(() => null);

    if (stream !== null) {
      opened.push(started);
      stream.close();
    }
  }

  expect(opened).toEqual([{ session: 'main', output }]);
});
