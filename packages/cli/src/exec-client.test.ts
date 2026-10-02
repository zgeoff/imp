import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { EXEC_CHANNELS } from '@imp/api';
import { runExec } from './exec-client';
import type { ExecIo } from './exec-client';
import { startFakeImpd } from './fake-impd';
import type { FakeImpd, FakeImpdPeer, FakeImpdReceived } from './fake-impd';

const BOX = { name: 'box', argv: ['cmd'], tty: false } as const;

afterEach(() => {
  mock.restore();
});

// a non-terminal stdin the test writes, and the output the client wrote
function setupIo(impd: Pick<FakeImpd, 'token' | 'url'>, overrides: Partial<ExecIo> = {}) {
  const stdin = new PassThrough();

  const output: string[] = [];
  const errors = spyOn(console, 'error').mockImplementation(() => {});

  // a loop sets up several; each reads only its own lines
  errors.mockClear();

  const io: ExecIo = {
    env: { IMP_URL: impd.url, IMP_TOKEN: impd.token },
    stdin,
    writeOutput: (fd, data) => {
      output.push(`${String(fd)}:${new TextDecoder().decode(data)}`);
    },
    ...overrides,
  };

  return {
    io,
    stdin,
    output,
    readErrors: () => errors.mock.calls.map((call) => String(call[0])),
  };
}

// starts every command, then lets `then` script the rest
function startThen(then: (peer: FakeImpdPeer, message: FakeImpdReceived) => void) {
  return (peer: FakeImpdPeer, message: FakeImpdReceived): void => {
    if (message['type'] === 'start') {
      peer.send({ type: 'started', pid: 7 });
    }

    then(peer, message);
  };
}

test('it streams output and stdin and exits with the command code', async () => {
  await using impd = startFakeImpd(
    startThen((peer, message) => {
      if (message['type'] === 'start') {
        peer.sendFrame(EXEC_CHANNELS.stdout, 'out');
        peer.sendFrame(EXEC_CHANNELS.stderr, 'err');
      }

      if (message['type'] === 'stdin_eof') {
        peer.send({ type: 'exit', code: 3, signal: null });
      }
    }),
  );

  const ctx = setupIo(impd);
  const code = runExec(BOX, ctx.io);

  await impd.waitFor((received) => received.length === 1);

  ctx.stdin.end('typed');

  const exitCode = await code;

  expect(exitCode).toBe(3);
  expect(ctx.output).toEqual(['1:out', '2:err']);

  expect(impd.received).toEqual([
    { type: 'start', name: 'box', argv: ['cmd'], tty: false },
    { stdin: 'typed' },
    { type: 'stdin_eof' },
  ]);
});

test('it exits 128 + n for a signal, a numbered one included', async () => {
  for (const [signal, expected] of [
    ['SIGKILL', 137],
    ['SIG34', 162],
  ] as const) {
    await using impd = startFakeImpd(
      startThen((peer) => {
        peer.send({ type: 'exit', code: null, signal });
      }),
    );

    const exitCode = await runExec(BOX, setupIo(impd).io);

    expect(exitCode).toBe(expected);
  }
});

test('it exits 255 for an exit with neither a code nor a known signal', async () => {
  for (const signal of [null, 'SIGNOPE']) {
    await using impd = startFakeImpd(
      startThen((peer) => {
        peer.send({ type: 'exit', code: null, signal });
      }),
    );

    const exitCode = await runExec(BOX, setupIo(impd).io);

    expect(exitCode).toBe(255);
  }
});

test('it ignores a repeated started, so stdin goes over once', async () => {
  await using impd = startFakeImpd(
    startThen((peer, message) => {
      if (message['type'] === 'start') {
        peer.send({ type: 'started', pid: 7 });
      }

      if (message['type'] === 'stdin_eof') {
        peer.send({ type: 'exit', code: 0, signal: null });
      }
    }),
  );

  const ctx = setupIo(impd);
  const code = runExec(BOX, ctx.io);

  await impd.waitFor((received) => received.length === 1);

  ctx.stdin.end('typed');

  const exitCode = await code;

  expect(exitCode).toBe(0);
  expect(impd.received.slice(1)).toEqual([{ stdin: 'typed' }, { type: 'stdin_eof' }]);
});

test('it exits 255 for an IMP_URL that is not an http URL', async () => {
  const ctx = setupIo({ url: 'localhost:7070', token: 'x' });

  const exitCode = await runExec(BOX, ctx.io);

  expect(exitCode).toBe(255);
  expect(ctx.readErrors()).toEqual(['imp: IMP_URL is not an http(s) URL: localhost:7070']);
});

test('it exits 127 when the command cannot start, and 255 for other refusals', async () => {
  for (const [code, expected] of [
    ['EXEC_FAILED', 127],
    ['NOT_FOUND', 255],
  ] as const) {
    await using impd = startFakeImpd((peer) => {
      peer.send({ type: 'error', code, message: 'nope' });
    });

    const ctx = setupIo(impd);

    const exitCode = await runExec(BOX, ctx.io);

    expect(exitCode).toBe(expected);
    expect(ctx.readErrors()).toEqual([`imp: ${code}: nope`]);
  }
});

test('it ends the session on a bad frame or bad JSON, and closes the socket', async () => {
  const replies: readonly ((peer: FakeImpdPeer) => void)[] = [
    (peer) => {
      peer.sendFrame(9, 'x');
    },
    (peer) => {
      peer.sendText('{not json');
    },
    (peer) => {
      peer.sendFrame(EXEC_CHANNELS.stdin, 'x');
    },
  ];

  for (const reply of replies) {
    await using impd = startFakeImpd(startThen(reply));

    const ctx = setupIo(impd);

    const exitCode = await runExec(BOX, ctx.io);

    expect(exitCode).toBe(255);
    expect(ctx.readErrors()[0]).toStartWith('imp: bad message from impd: ');

    await impd.closed;
  }
});

test('it exits 255 when the connection drops after started without an exit', async () => {
  await using impd = startFakeImpd(
    startThen((peer) => {
      peer.close(1011, 'agent gone');
    }),
  );

  const ctx = setupIo(impd);

  const exitCode = await runExec(BOX, ctx.io);

  expect(exitCode).toBe(255);
  expect(ctx.readErrors()).toEqual(['imp: exec connection closed (agent gone)']);
});

test('it tells a rejected token apart from an unreachable impd', async () => {
  await using impd = startFakeImpd(() => {});

  const rejected = setupIo({ url: impd.url, token: 'wrong' });

  const exitCode = await runExec(BOX, rejected.io);

  expect(exitCode).toBe(255);
  expect(rejected.readErrors()[0]).toStartWith('imp: unauthorized: set IMP_TOKEN');

  const gone = startFakeImpd(() => {}, '/imp');

  await gone[Symbol.asyncDispose]();

  const unreachable = setupIo(gone);

  const unreachableCode = await runExec(BOX, unreachable.io);

  expect(unreachableCode).toBe(255);
  expect(unreachable.readErrors()[0]).toStartWith(`imp: cannot reach impd at ${gone.url} (`);
});

test('it keeps the IMP_URL path prefix', async () => {
  await using impd = startFakeImpd(
    startThen((peer) => {
      peer.send({ type: 'exit', code: 0, signal: null });
    }),
    '/imp',
  );

  const exitCode = await runExec(BOX, setupIo(impd).io);

  expect(exitCode).toBe(0);
  expect(impd.paths).toEqual(['/imp/exec']);
});

test('it exits 141 quietly when its output goes away, and closes the socket', async () => {
  await using impd = startFakeImpd(
    startThen((peer) => {
      peer.sendFrame(EXEC_CHANNELS.stdout, 'out');
    }),
  );

  const ctx = setupIo(impd, {
    writeOutput: () => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    },
  });

  const exitCode = await runExec(BOX, ctx.io);

  expect(exitCode).toBe(141);
  expect(ctx.readErrors()).toEqual([]);

  await impd.closed;
});

test('it pauses stdin while the socket buffer is high and resumes once it drains', async () => {
  await using impd = startFakeImpd(
    startThen((peer, message) => {
      if (message['type'] === 'stdin_eof') {
        peer.send({ type: 'exit', code: 0, signal: null });
      }
    }),
  );

  const buffer = { bytes: 0 };

  const ctx = setupIo(impd, {
    connect: (url, headers) => {
      const ws = new WebSocket(url, { headers });

      Object.defineProperty(ws, 'bufferedAmount', { get: () => buffer.bytes });

      return ws;
    },
  });

  const code = runExec(BOX, ctx.io);

  await impd.waitFor((received) => received.length === 1);

  buffer.bytes = 2 * 1_048_576;

  ctx.stdin.write('first');

  await impd.waitFor((received) => received.length === 2);

  expect(ctx.stdin.isPaused()).toBe(true);

  buffer.bytes = 0;

  ctx.stdin.write('second');

  await impd.waitFor((received) => received.length === 3);

  expect(ctx.stdin.isPaused()).toBe(false);
  expect(impd.received.slice(1)).toEqual([{ stdin: 'first' }, { stdin: 'second' }]);

  ctx.stdin.end();

  const exitCode = await code;

  expect(exitCode).toBe(0);
});
