import * as z from 'zod';
import type { AgentInner } from '../agent-client/agent-protocol';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

const RequestSchema = z.looseObject({ op: z.string() });

interface StubInnerAgentOptions {
  // the inner container its ping reports
  readonly inner: AgentInner;

  // closes the agent; at the test's end by default
  readonly stack?: Readonly<AsyncDisposableStack>;
}

// A guest agent at `path` that answers what the idle loop asks: its ping
// reports `inner`, as a 0.18.0 agent's does, and its activity no connections
// and no sessions. Any other op gets UNKNOWN_OP.
export function startStubInnerAgent(path: string, options: Readonly<StubInnerAgentOptions>) {
  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  return startStubAgent(
    path,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const op = RequestSchema.parse(decodeJsonPayload(request)).op;

      if (op === 'ping') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            ok: true,
            version: '0.18.0',
            inner: options.inner,
          }),
        );
      } else if (op === 'activity') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            tcp_established: 0,
            exec_sessions: 0,
            load1: 0,
            sessions: [],
          }),
        );
      } else {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            error: { code: 'UNKNOWN_OP', message: `unknown op ${op}` },
          }),
        );
      }
    },
    closeWith,
  );
}
