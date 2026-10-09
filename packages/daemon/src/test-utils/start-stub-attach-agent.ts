import * as z from 'zod';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

const RequestSchema = z.looseObject({ op: z.string() });

// one answer to a session request: its frame, and whether the agent ends the
// connection after it (an error) or keeps it open (a STARTED stream)
interface StubAttachReply {
  readonly frame: Uint8Array;
  readonly isEnd: boolean;
}

interface StubAttachAgentOptions {
  // the boot its ping reports
  readonly bootId: string;

  // the answers to the session requests, in order; a request past the last
  // one gets its connection ended with no answer
  readonly replies?: readonly StubAttachReply[];

  // closes the agent; at the test's end by default
  readonly stack?: Readonly<AsyncDisposableStack>;
}

// A guest agent at `path` from 0.15.0, with sessions: its ping reports
// `bootId`, and each other request gets the next of `replies`.
export async function startStubAttachAgent(
  path: string,
  options: Readonly<StubAttachAgentOptions>,
) {
  const replies = [...(options.replies ?? [])];
  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  const agent = await startStubAgent(
    path,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const parsed = RequestSchema.parse(decodeJsonPayload(request));

      if (parsed.op === 'ping') {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            ok: true,
            version: '0.15.0',
            boot_id: options.bootId,
          }),
        );

        return;
      }

      const reply = replies.shift();

      if (reply === undefined) {
        socket.end();
      } else if (reply.isEnd) {
        socket.end(reply.frame);
      } else {
        socket.write(reply.frame);
      }
    },
    closeWith,
  );

  return {
    close: agent.close,

    // the ops of the requests it got, in order
    readOps: (): string[] =>
      agent.received.map((frame) => RequestSchema.parse(decodeJsonPayload(frame)).op),
  };
}
