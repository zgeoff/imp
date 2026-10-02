import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { EXEC_CHANNELS } from '@imp/api';
import { runExec } from './exec-client';
import type { ExecIo } from './exec-client';
import { startFakeImpd } from './fake-impd';
import type { FakeImpd, FakeImpdPeer, FakeImpdReceived } from './fake-impd';

const BOX = { host: null, name: 'box', argv: ['cmd'], tty: false } as const;

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

test('an exec in the agent sends outer through to impd', async () => {
  await using impd = startFakeImpd(
    startThen((peer, message) => {
      if (message['type'] === 'start') {
        peer.send({ type: 'exit', code: 0, signal: null });
      }
    }),
  );

  const ctx = setupIo(impd);

  const exitCode = await runExec({ ...BOX, argv: ['ls', '/user'], outer: true }, ctx.io);

  expect(exitCode).toBe(0);

  expect(impd.received[0]).toEqual({
    type: 'start',
    name: 'box',
    argv: ['ls', '/user'],
    tty: false,
    outer: true,
  });
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

test('it explains INNER_DOWN and exits 255', async () => {
  await using impd = startFakeImpd((peer) => {
    peer.send({ type: 'error', code: 'INNER_DOWN', message: 'the inner container is down' });
  });

  const ctx = setupIo(impd);

  const exitCode = await runExec(BOX, ctx.io);

  const [error] = ctx.readErrors();

  expect(exitCode).toBe(255);

  expect(error).toStartWith(
    'imp: INNER_DOWN: the inner container is down (the container in the imp',
  );
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

const SESSION_BOX = {
  host: null,
  name: 'box',
  argv: ['sh'],
  tty: true,
  session: { name: 'main', attachOnly: false, detachKey: 0x1d },
} as const;

// a stdin that claims to be a terminal and logs its raw mode
function setupTerminal(impd: Pick<FakeImpd, 'token' | 'url'>, overrides: Partial<ExecIo> = {}) {
  const raw: boolean[] = [];

  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      raw.push(mode);
    },
  });

  const io = setupIo(impd, {
    stdin,
    reattachDelayMs: 5,
    isAttachedElsewhere: () => Promise.resolve(false),
    ...overrides,
  });

  return { ...io, stdin, raw };
}

test('a session starts with its name, and a detach key detaches without a signal', async () => {
  await using impd = startFakeImpd((peer, message) => {
    if (message['type'] === 'start') {
      peer.send({ type: 'started', pid: 7, session: 'main', created: true });
    }
  });

  const ctx = setupTerminal(impd);
  const code = runExec(SESSION_BOX, ctx.io);

  await impd.waitFor((received) => received.length === 1);

  ctx.stdin.write('ls\u001Dmore');

  const exitCode = await code;

  await impd.closed;

  expect(exitCode).toBe(0);

  expect(impd.received).toEqual([
    { type: 'start', name: 'box', argv: ['sh'], tty: true, session: 'main' },
    { stdin: 'ls' },
  ]);

  expect(ctx.raw).toEqual([true, false]);
  expect(ctx.output.at(-1)).toStartWith('1:');
  expect(ctx.output.at(-1)).toContain('\u001B[>4;0m');
  expect(ctx.readErrors()).toEqual(['imp: detached from session main (imp attach box main)']);
});

test('an attach sends attach, and clears the screen before the replay', async () => {
  await using impd = startFakeImpd((peer, message) => {
    if (message['type'] === 'attach') {
      peer.send({ type: 'started', pid: 7, session: 'main', created: false });
      peer.sendFrame(EXEC_CHANNELS.stdout, 'replay');
      peer.send({ type: 'exit', code: 0, signal: null });
    }
  });

  const ctx = setupTerminal(impd);

  const exitCode = await runExec(
    { ...SESSION_BOX, argv: [], session: { ...SESSION_BOX.session, attachOnly: true } },
    ctx.io,
  );

  expect(exitCode).toBe(0);
  expect(impd.received).toEqual([{ type: 'attach', name: 'box', session: 'main' }]);
  expect(ctx.output.slice(0, 2)).toEqual(['1:\u001B[H\u001B[2J', '1:replay']);
});

test('a lost session or an impd restart attaches again by itself', async () => {
  for (const drop of [
    (peer: FakeImpdPeer) => {
      peer.send({ type: 'detached', reason: 'lost' });
    },
    (peer: FakeImpdPeer) => {
      peer.close(1012, 'impd is restarting');
    },
    (peer: FakeImpdPeer) => {
      peer.send({ type: 'detached', reason: 'slow' });
    },
  ]) {
    await using impd = startFakeImpd((peer, message) => {
      if (message['type'] === 'start') {
        peer.send({ type: 'started', pid: 7, session: 'main', created: true });

        drop(peer);
      }

      if (message['type'] === 'attach') {
        peer.send({ type: 'started', pid: 7, session: 'main', created: false });
        peer.send({ type: 'exit', code: 4, signal: null });
      }
    });

    const ctx = setupTerminal(impd);

    const exitCode = await runExec(SESSION_BOX, ctx.io);

    expect(exitCode).toBe(4);
    expect(impd.received.map((message) => message['type'])).toEqual(['start', 'attach']);
    expect(ctx.output.join('')).toContain('lost the connection to session main; attaching again');
  }
});

test('keys typed while it attaches again reach the new session', async () => {
  await using impd = startFakeImpd((peer, message) => {
    if (message['type'] === 'start') {
      peer.send({ type: 'started', pid: 7, session: 'main', created: true });
      peer.send({ type: 'detached', reason: 'lost' });
    }

    if (message['type'] === 'attach') {
      peer.send({ type: 'started', pid: 7, session: 'main', created: false });
    }

    if (message['stdin'] === 'typed') {
      peer.send({ type: 'exit', code: 0, signal: null });
    }
  });

  const ctx = setupTerminal(impd, { reattachDelayMs: 50 });
  const code = runExec(SESSION_BOX, ctx.io);

  await waitForOutput(ctx.output, 'attaching again');

  ctx.stdin.write('typed');

  const exitCode = await code;

  expect(exitCode).toBe(0);

  expect(impd.received).toEqual([
    { type: 'start', name: 'box', argv: ['sh'], tty: true, session: 'main' },
    { type: 'attach', name: 'box', session: 'main' },
    { stdin: 'typed' },
  ]);

  expect(ctx.output.join('')).toContain('imp: attached again to session main');
});

// a session that drops at its start and never comes back
function startLostSession(peer: FakeImpdPeer, message: FakeImpdReceived): void {
  if (message['type'] === 'start') {
    peer.send({ type: 'started', pid: 7, session: 'main', created: true });
    peer.send({ type: 'detached', reason: 'lost' });
  }
}

async function waitForOutput(output: readonly string[], text: string): Promise<void> {
  while (!output.join('').includes(text)) {
    await Bun.sleep(1);
  }
}

test('the detach key, in any of its forms, works while it attaches again', async () => {
  for (const key of ['\u001D', '\u001B[93;5u', '\u001B[27;5;93~']) {
    await using impd = startFakeImpd(startLostSession);

    const ctx = setupTerminal(impd, { reattachDelayMs: 60_000 });
    const code = runExec(SESSION_BOX, ctx.io);

    await waitForOutput(ctx.output, 'attaching again');

    ctx.stdin.write(`typed${key}`);

    const exitCode = await code;

    expect(exitCode).toBe(0);
    expect(ctx.readErrors()).toEqual(['imp: detached from session main (imp attach box main)']);
  }
});

test('ctrl-c while it attaches again gives up with 130', async () => {
  await using impd = startFakeImpd(startLostSession);

  const ctx = setupTerminal(impd, { reattachDelayMs: 60_000 });
  const code = runExec(SESSION_BOX, ctx.io);

  await waitForOutput(ctx.output, 'attaching again');

  ctx.stdin.write('\u0003');

  const exitCode = await code;

  expect(exitCode).toBe(130);
});

test('it does not attach again once another client attached', async () => {
  await using impd = startFakeImpd(startLostSession);

  const asked: string[] = [];

  const ctx = setupTerminal(impd, {
    isAttachedElsewhere: (imp, session) => {
      asked.push(`${imp}/${session}`);

      return Promise.resolve(true);
    },
  });

  const exitCode = await runExec(SESSION_BOX, ctx.io);

  expect(exitCode).toBe(254);
  expect(asked).toEqual(['box/main']);
  expect(impd.received.map((message) => message['type'])).toEqual(['start']);

  expect(ctx.readErrors()).toEqual([
    'imp: another client attached to session main (imp attach box main)',
  ]);
});

test('a detach key in its kitty form detaches', async () => {
  await using impd = startFakeImpd((peer, message) => {
    if (message['type'] === 'start') {
      peer.send({ type: 'started', pid: 7, session: 'main', created: true });
    }
  });

  const ctx = setupTerminal(impd);
  const code = runExec(SESSION_BOX, ctx.io);

  await impd.waitFor((received) => received.length === 1);

  ctx.stdin.write('ls\u001B[93;5umore');

  const exitCode = await code;

  await impd.closed;

  expect(exitCode).toBe(0);
  expect(impd.received.slice(1)).toEqual([{ stdin: 'ls' }]);
});

test('it waits longer before each new try', async () => {
  await using impd = startFakeImpd((peer, message) => {
    startLostSession(peer, message);

    if (message['type'] === 'attach') {
      peer.close(1011, 'no agent');
    }
  });

  const ctx = setupTerminal(impd, { reattachDelayMs: 20, reattachWindowMs: 400 });

  await runExec(SESSION_BOX, ctx.io);

  // 20, 40, 80 and 160 ms fit in the window; without the backoff, about 20
  const attaches = impd.received.filter((message) => message['type'] === 'attach');

  expect(attaches.length).toBeGreaterThanOrEqual(3);
  expect(attaches.length).toBeLessThanOrEqual(5);
});

test('a takeover ends the CLI without attaching again', async () => {
  await using impd = startFakeImpd((peer, message) => {
    if (message['type'] === 'start') {
      peer.send({ type: 'started', pid: 7, session: 'main', created: true });
      peer.send({ type: 'detached', reason: 'taken_over' });
    }
  });

  const ctx = setupTerminal(impd);

  const exitCode = await runExec(SESSION_BOX, ctx.io);

  expect(exitCode).toBe(254);
  expect(impd.received.map((message) => message['type'])).toEqual(['start']);

  expect(ctx.readErrors()).toEqual([
    'imp: another client attached to session main (imp attach box main)',
  ]);
});

test('a session that cannot be attached again within the window fails', async () => {
  await using impd = startFakeImpd((peer, message) => {
    if (message['type'] === 'start') {
      peer.send({ type: 'started', pid: 7, session: 'main', created: true });
      peer.send({ type: 'detached', reason: 'lost' });
    }

    // the imp does not come back
    if (message['type'] === 'attach') {
      peer.close(1011, 'no agent');
    }
  });

  const ctx = setupTerminal(impd, { reattachWindowMs: 50 });

  const exitCode = await runExec(SESSION_BOX, ctx.io);

  expect(exitCode).toBe(255);
  expect(impd.received.filter((message) => message['type'] === 'attach').length).toBeGreaterThan(1);
  expect(ctx.readErrors().at(-1)).toBe('imp: exec connection closed (no agent)');
});

test('a plain exec has no detach key, and a lost connection is not attached again', async () => {
  await using impd = startFakeImpd((peer, message) => {
    if (message['type'] === 'start') {
      peer.send({ type: 'started', pid: 7 });
    }

    if (message['stdin'] === '\u001D') {
      peer.close(1012, 'impd is restarting');
    }
  });

  const ctx = setupTerminal(impd);
  const code = runExec({ ...BOX, tty: true }, ctx.io);

  await impd.waitFor((received) => received.length === 1);

  ctx.stdin.write('\u001D');

  const exitCode = await code;

  expect(exitCode).toBe(255);
  expect(impd.received.map((message) => message['type'] ?? 'stdin')).toEqual(['start', 'stdin']);
});
