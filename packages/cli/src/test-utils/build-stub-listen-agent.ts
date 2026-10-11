import type { Socket } from 'node:net';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '@imp/daemon/src/agent-client/frame-codec';
import type { StubAgentHandler } from '@imp/daemon/src/test-utils/start-stub-agent';
import * as z from 'zod';

// the op of a request in its wire form
const RequestSchema = z.looseObject({ op: z.string() });

interface AgentRefusal {
  readonly code: string;
  readonly message: string;
}

interface StubListenAgentOptions {
  // where each listen says it listens: a port, or a unix socket's path
  readonly listening: Readonly<{ port: number }> | Readonly<{ path: string }>;

  // when set, each listen has one client waiting at once, which sends these
  // bytes once accepted and closes once the forward's side closes
  readonly clientSends?: string;
}

// An imp's agent for a reverse forward, for startStubAgent: each listen is
// `fwd<N>`, open in `listens` until the test ends it, or refuseListens'
// error; other ops, such as a sleep's, end with no answer.
export function buildStubListenAgent(options: Readonly<StubListenAgentOptions>) {
  const listens: Socket[] = [];
  const refusal: { error: AgentRefusal | null } = { error: null };

  const readFrame: StubAgentHandler = (socket, request, frames) => {
    if (frames.length > 1) {
      if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
        socket.end(encodeFrame(FRAME_TYPES.stdoutEof));
      }

      return;
    }

    const op = RequestSchema.parse(decodeJsonPayload(request)).op;

    if (op === 'listen' && refusal.error !== null) {
      socket.end(encodeJsonFrame(FRAME_TYPES.response, { error: refusal.error }));
    } else if (op === 'listen') {
      listens.push(socket);

      const id = listens.length;

      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, {
          ok: true,
          listener: `fwd${String(id)}`,
          ...options.listening,
        }),
      );

      if (options.clientSends !== undefined) {
        socket.write(encodeJsonFrame(FRAME_TYPES.connection, { id }));
      }
    } else if (op === 'agent.accept') {
      socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
      socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode(options.clientSends)));
    } else {
      socket.end();
    }
  };

  return {
    readFrame,
    listens,
    refuseListens: (error: AgentRefusal) => {
      refusal.error = error;
    },
  };
}
