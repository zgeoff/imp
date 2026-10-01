import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendPing } from './agent-requests';
import { openExecStream } from './exec-stream';
import type { ExecEvent, ExecStream } from './exec-stream';
import {
  FRAME_TYPES,
  createFrameDecoder,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from './frame-codec';
import type { AgentFrame } from './frame-codec';

type FakeAgent = (socket: Socket, request: AgentFrame, frames: readonly AgentFrame[]) => void;

// A unix socket that answers the Firecracker CONNECT handshake, then hands
// each decoded frame to `agent`.
async function setupFakeVsock(agent: FakeAgent) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vsock-'));
  const path = join(dir, 'vsock.sock');
  const received: AgentFrame[] = [];

  const server = createServer((socket) => {
    const decoder = createFrameDecoder();
    let handshaken = false;
    let request: AgentFrame | null = null;

    socket.on('data', (chunk: Uint8Array) => {
      let bytes = chunk;

      if (!handshaken) {
        const newline = bytes.indexOf(10);

        handshaken = true;

        socket.write('OK 1073741824\n');

        bytes = bytes.subarray(newline + 1);
      }

      for (const frame of decoder.push(bytes)) {
        received.push(frame);

        request ??= frame;

        agent(socket, request, received);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  return {
    path,
    received,
    [Symbol.dispose]() {
      server.close();

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

  expect(opening).rejects.toMatchObject({ code: 'EXEC_FAILED' });
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
    expect(sendPing(path, 500)).rejects.toThrow();
  } finally {
    server.close();

    rmSync(dir, { recursive: true, force: true });
  }
});
