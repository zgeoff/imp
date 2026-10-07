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

// A unix socket at `path`, where Firecracker would put the guest's vsock,
// that answers the CONNECT handshake and hands each decoded frame to
// `agent`. `received` holds every frame of every connection.
export async function startStubAgent(path: string, agent: StubAgentHandler) {
  const received: AgentFrame[] = [];

  mkdirSync(dirname(path), { recursive: true });

  const server = createServer((socket) => {
    const decoder = createFrameDecoder();
    const frames: AgentFrame[] = [];
    let handshaken = false;

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
        frames.push(frame);

        agent(socket, frames[0] ?? frame, frames);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  return {
    received,
    close: () => {
      server.close();
    },
  };
}
