import type { Socket } from 'node:net';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '@imp/daemon/src/agent-client/frame-codec';
import type { StubAgentHandler } from '@imp/daemon/src/test-utils/start-stub-agent';
import * as z from 'zod';

// what a listen or an accept asks the agent, in its wire form
const RequestSchema = z.looseObject({
  op: z.string(),
  network: z.string().optional(),
  address: z.string().optional(),
});

type StubRequest = z.infer<typeof RequestSchema>;

interface AgentRefusal {
  readonly code: string;
  readonly message: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// where a listen of `address` listens: a unix socket at its path, or the
// agent's own one for an empty path; a tcp listen gets port 4000
function readListening(request: Readonly<StubRequest>) {
  if (request.network === 'tcp') {
    return { port: 4000 };
  }

  return { path: request.address === '' ? '/run/imp/forward/1.sock' : request.address };
}

// An imp's guest agent for reverse forwards, for startStubAgent: listeners
// `fwd<N>`, until refuseListens; an accepted client answers `got <bytes>`.
// endListeners ends them all, as a forced sleep does.
export function buildStubForwardAgent() {
  const requests: StubRequest[] = [];
  const listeners: Socket[] = [];
  const refusal: { error: AgentRefusal | null } = { error: null };

  const readFrame: StubAgentHandler = (socket, request, frames) => {
    if (frames.length > 1) {
      const frame = frames.at(-1);

      if (frame?.type === FRAME_TYPES.stdin) {
        const reply = encoder.encode(`got ${decoder.decode(frame.payload)}`);

        socket.write(encodeFrame(FRAME_TYPES.stdout, reply));
        socket.write(encodeFrame(FRAME_TYPES.stdoutEof));
      }

      if (frame?.type === FRAME_TYPES.stdinEof) {
        socket.end();
      }

      return;
    }

    const parsed = RequestSchema.parse(decodeJsonPayload(request));

    requests.push(parsed);
    socket.on('error', () => {});

    if (parsed.op === 'listen' && refusal.error !== null) {
      socket.end(encodeJsonFrame(FRAME_TYPES.response, { error: refusal.error }));
    } else if (parsed.op === 'listen') {
      listeners.push(socket);

      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, {
          ok: true,
          listener: `fwd${String(listeners.length)}`,
          ...readListening(parsed),
        }),
      );
    } else if (parsed.op === 'agent.accept') {
      socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
    } else {
      socket.end(
        encodeJsonFrame(FRAME_TYPES.response, {
          error: { code: 'UNKNOWN_OP', message: `unknown op ${parsed.op}` },
        }),
      );
    }
  };

  return {
    requests,
    readFrame,
    connect: (id: number) => {
      listeners.at(-1)?.write(encodeJsonFrame(FRAME_TYPES.connection, { id }));
    },
    endListeners: () => {
      for (const listener of listeners) {
        listener.end();
      }
    },
    refuseListens: (error: AgentRefusal) => {
      refusal.error = error;
    },
  };
}
