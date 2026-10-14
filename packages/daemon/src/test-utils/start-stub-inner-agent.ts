import { create, toJson } from '@bufbuild/protobuf';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { InnerStatusSchema, RequestSchema } from '../agent-client/agent-protocol';
import { decodeAgentMessage } from '../agent-client/decode-agent-message';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

interface StubInnerAgentOptions {
  // the inner container its ping reports
  readonly inner: MessageInitShape<typeof InnerStatusSchema>;

  // closes the agent; at the test's end by default
  readonly stack?: Readonly<AsyncDisposableStack>;
}

// A guest agent at `path` that answers what the idle loop asks: its ping
// reports `inner`, as a 0.18.0 agent's does, and its activity no connections
// and no sessions. Any other op gets UNKNOWN_OP.
export function startStubInnerAgent(path: string, options: Readonly<StubInnerAgentOptions>) {
  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  // every field the agent always writes, zero or not
  const inner = toJson(InnerStatusSchema, create(InnerStatusSchema, options.inner), {
    useProtoFieldName: true,
    alwaysEmitImplicit: true,
  });

  return startStubAgent(
    path,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const op = decodeAgentMessage(RequestSchema, decodeJsonPayload(request)).op;

      if (op === 'ping') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            ok: true,
            version: '0.18.0',
            inner,
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
