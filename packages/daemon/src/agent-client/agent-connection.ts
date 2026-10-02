import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { createFrameDecoder, encodeFrame, encodeJsonFrame } from './frame-codec';
import type { AgentFrame, FrameType } from './frame-codec';

const AGENT_PORT = 1024;

// frames queued before the socket stops reading, and when it reads again: a
// reader that falls behind pushes back on the guest through vsock
const PAUSE_FRAMES = 64;
const RESUME_FRAMES = 16;

// One agent connection carries one request (agent/PROTOCOL.md).
export interface AgentConnection {
  readonly send: (type: FrameType, payload?: Uint8Array) => void;
  readonly sendJson: (type: FrameType, value: unknown) => void;

  // the next frame, or null once the agent closed the connection cleanly
  readonly next: () => Promise<AgentFrame | null>;
  readonly close: () => void;
}

// An agent-side failure: a RESPONSE with an `error` object.
export class AgentError extends Error {
  readonly code: string;

  // the agent's message without the code, for a client that shows the code
  // on its own
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);

    this.name = 'AgentError';
    this.code = code;
    this.detail = detail;
  }
}

// Connects to Firecracker's vsock socket and runs the `CONNECT` handshake.
// Rejects when the agent is not listening yet, so callers can retry.
export function openAgentConnection(vsockPath: string, timeoutMs = 2000): Promise<AgentConnection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: vsockPath });

    const timer = setTimeout(() => {
      socket.destroy();

      reject(new Error(`vsock handshake timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);

    let line = '';

    const onData = (chunk: Uint8Array): void => {
      const newline = chunk.indexOf(10);

      if (newline === -1) {
        line += new TextDecoder().decode(chunk);

        return;
      }

      line += new TextDecoder().decode(chunk.subarray(0, newline));

      socket.off('data', onData);

      clearTimeout(timer);

      if (!line.startsWith('OK ')) {
        socket.destroy();

        reject(new Error(`vsock handshake refused: ${JSON.stringify(line)}`));

        return;
      }

      resolve(buildConnection(socket, chunk.subarray(newline + 1)));
    };

    socket.on('data', onData);

    socket.once('connect', () => {
      socket.write(`CONNECT ${String(AGENT_PORT)}\n`);
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error('vsock closed during the handshake'));
    });
  });
}

function buildConnection(socket: Socket, leftover: Uint8Array): AgentConnection {
  const decoder = createFrameDecoder();
  const frames: AgentFrame[] = [];

  // an object, not lets: the closures below mutate it and read it back
  const state: { ended: boolean; failure: Error | null; wake: (() => void) | null } = {
    ended: false,
    failure: null,
    wake: null,
  };

  const resolveWaiter = (): void => {
    state.wake?.();
    state.wake = null;
  };

  const handleData = (chunk: Uint8Array): void => {
    try {
      frames.push(...decoder.push(chunk));

      if (frames.length >= PAUSE_FRAMES) {
        socket.pause();
      }
    } catch (error) {
      state.failure = error instanceof Error ? error : new Error(String(error));

      socket.destroy();
    }

    resolveWaiter();
  };

  socket.removeAllListeners('error');
  socket.removeAllListeners('close');
  socket.on('data', handleData);

  socket.on('error', (error) => {
    state.failure ??= error;

    resolveWaiter();
  });

  socket.on('close', () => {
    if (state.failure === null) {
      try {
        decoder.end();
      } catch (error) {
        state.failure = error instanceof Error ? error : new Error(String(error));
      }
    }

    state.ended = true;

    resolveWaiter();
  });

  if (leftover.byteLength > 0) {
    handleData(leftover);
  }

  const waitForData = (): Promise<void> =>
    new Promise((resolve) => {
      state.wake = resolve;
    });

  const readNext = async (): Promise<AgentFrame | null> => {
    for (;;) {
      const frame = frames.shift();
      const error = state.failure;

      if (frame !== undefined) {
        if (frames.length <= RESUME_FRAMES && socket.isPaused()) {
          socket.resume();
        }

        return frame;
      }

      if (error !== null) {
        throw error;
      }

      if (state.ended) {
        return null;
      }

      await waitForData();
    }
  };

  return {
    send: (type, payload) => {
      if (!socket.destroyed) {
        socket.write(encodeFrame(type, payload));
      }
    },
    sendJson: (type, value) => {
      if (!socket.destroyed) {
        socket.write(encodeJsonFrame(type, value));
      }
    },
    next: readNext,
    close: () => {
      socket.destroy();
    },
  };
}
