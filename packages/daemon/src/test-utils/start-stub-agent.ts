import { onTestFinished } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { dirname } from 'node:path';
import { createFrameDecoder } from '../agent-client/frame-codec';
import type { AgentFrame } from '../agent-client/frame-codec';

// gets every frame of a connection in turn: the first is the request
export type StubAgentHandler = (
  socket: Socket,
  request: AgentFrame,
  frames: readonly AgentFrame[],
) => void;

// A unix socket at `path` for the guest's vsock: it answers CONNECT, hands
// each frame to `agent` and keeps it in `received`. It closes with `stack`
// when given one, else at the test's end.
export async function startStubAgent(
  path: string,
  agent: StubAgentHandler,
  options: Readonly<{ stack?: Readonly<AsyncDisposableStack> }> = {},
) {
  const received: AgentFrame[] = [];

  // the chunks read so far, for a test that splits its writes
  const counts = { reads: 0 };

  mkdirSync(dirname(path), { recursive: true });

  const server = createServer((socket) => {
    const decoder = createFrameDecoder();
    const frames: AgentFrame[] = [];

    // the bytes of a CONNECT line whose newline has not arrived yet; null
    // once the handshake is answered
    let pending: Uint8Array | null = new Uint8Array();

    socket.on('data', (chunk: Uint8Array) => {
      counts.reads += 1;

      let bytes = chunk;

      if (pending !== null) {
        const line = Buffer.concat([pending, chunk]);
        const newline = line.indexOf(10);

        if (newline === -1) {
          pending = line;

          return;
        }

        pending = null;

        socket.write('OK 1073741824\n');

        bytes = line.subarray(newline + 1);
      }

      for (const frame of decoder.push(bytes)) {
        received.push(frame);
        frames.push(frame);

        agent(socket, frames[0] ?? frame, frames);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  // a close after the test closed it already does nothing
  const stopServer = (): void => {
    server.close();
  };

  if (options.stack === undefined) {
    onTestFinished(stopServer);
  } else {
    options.stack.defer(stopServer);
  }

  return {
    received,
    get reads(): number {
      return counts.reads;
    },
    close: stopServer,
  };
}
