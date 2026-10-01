import { expect, test } from 'bun:test';
import { EXEC_CHANNELS, decodeExecFrame, encodeExecFrame } from '@imp/api';
import { AgentError } from '../agent-client/agent-connection';
import type { AgentExecRequest, ExecEvent, ExecStream } from '../agent-client/exec-stream';
import { createExecSession } from './exec-session';

interface EventSource {
  readonly next: () => Promise<ExecEvent>;
}

async function* readUntilExit(source: EventSource): AsyncGenerator<ExecEvent, void, undefined> {
  for (;;) {
    const event = await source.next();

    yield event;

    if (event.type === 'exit') {
      return;
    }
  }
}

// an exec stream whose events the test feeds and whose input it records
function buildFakeStream() {
  const queue: ExecEvent[] = [];
  const input: string[] = [];
  const waiting: { wake: (() => void) | null } = { wake: null };

  const emitEvent = (event: ExecEvent): void => {
    queue.push(event);
    waiting.wake?.();
  };

  const source: EventSource = {
    next: async () => {
      for (;;) {
        const event = queue.shift();

        if (event !== undefined) {
          return event;
        }

        await new Promise<void>((resolve) => {
          waiting.wake = resolve;
        });
      }
    },
  };

  const stream: ExecStream = {
    pid: 7,
    writeStdin: (data) => {
      input.push(`stdin:${new TextDecoder().decode(data)}`);
    },
    closeStdin: () => {
      input.push('eof');
    },
    resize: (cols, rows) => {
      input.push(`resize:${String(cols)}x${String(rows)}`);
    },
    sendSignal: (signal) => {
      input.push(`signal:${String(signal)}`);
    },
    events: () => readUntilExit(source),
    close: () => {
      input.push('close');
    },
  };

  return { stream, input, emitEvent };
}

function buildFakePeer() {
  const sent: unknown[] = [];
  const closes: number[] = [];

  return {
    sent,
    closes,
    peer: {
      sendText: (text: string) => {
        sent.push(JSON.parse(text));
      },
      sendBinary: (data: Uint8Array) => {
        const frame = decodeExecFrame(data);

        sent.push([frame.channel, new TextDecoder().decode(frame.data)]);
      },
      close: (code = 1000) => {
        closes.push(code);
      },
    },
  };
}

test('it bridges a WebSocket to an agent exec stream', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const requests: AgentExecRequest[] = [];

  const session = createExecSession(peer.peer, {
    openExec: (_name, request) => {
      requests.push(request);

      return Promise.resolve(fake.stream);
    },
    recordActivity: () => Promise.resolve(),
  });

  session.handleMessage({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    env: { TERM: 'xterm' },
    cols: 100,
    rows: 30,
  });

  // input before `started` waits for the stream
  session.handleMessage(encodeExecFrame(EXEC_CHANNELS.stdin, new TextEncoder().encode('ls\n')));
  session.handleMessage({ type: 'resize', cols: 120, rows: 40 });
  session.handleMessage({ type: 'signal', signal: 'SIGINT' });
  session.handleMessage({ type: 'stdin_eof' });

  await Bun.sleep(5);

  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('out') });
  fake.emitEvent({ type: 'exit', code: 137, signal: 9 });

  await Bun.sleep(5);

  expect(requests).toEqual([{ argv: ['sh'], tty: true, env: ['TERM=xterm'], cols: 100, rows: 30 }]);
  expect(fake.input).toEqual(['stdin:ls\n', 'resize:120x40', 'signal:2', 'eof', 'close']);

  expect(peer.sent).toEqual([
    { type: 'started', pid: 7 },
    [EXEC_CHANNELS.stdout, 'out'],
    { type: 'exit', code: null, signal: 'SIGKILL' },
  ]);

  expect(peer.closes).toEqual([1000]);
});

test('it reports an exec that cannot start and closes the socket', async () => {
  const peer = buildFakePeer();

  const session = createExecSession(peer.peer, {
    openExec: () => Promise.reject(new AgentError('EXEC_FAILED', 'no such file')),
    recordActivity: () => Promise.resolve(),
  });

  session.handleMessage({ type: 'start', name: 'dev', argv: ['nope'], tty: false });

  await Bun.sleep(5);

  expect(peer.sent).toEqual([
    { type: 'error', code: 'EXEC_FAILED', message: 'EXEC_FAILED: no such file' },
  ]);

  expect(peer.closes).toEqual([1011]);
});

test('it rejects a control message before start', () => {
  const peer = buildFakePeer();

  const session = createExecSession(peer.peer, {
    openExec: () => Promise.reject(new Error('unused')),
    recordActivity: () => Promise.resolve(),
  });

  session.handleMessage({ type: 'resize', cols: 1, rows: 1 });

  expect(peer.sent).toEqual([{ type: 'error', message: 'resize before start' }]);
});
