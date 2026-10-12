import { FRAME_TYPES } from '../agent-client/frame-codec';
import type { StubAgentHandler } from './start-stub-agent';

interface StubExecReplies {
  // the frames the agent writes once the request comes, such as `started`
  // and any output
  readonly started: readonly Uint8Array[];

  // the frames the agent writes once the caller's stdin ends, such as `exit`
  readonly exited: readonly Uint8Array[];

  // gets each stdin payload as it comes
  readonly onStdin?: (payload: Uint8Array) => void;

  // runs when stdin ends, before the `exited` frames go
  readonly onStdinEnd?: () => void;
}

// An exec in the guest agent of a command that reads all its stdin before it
// exits, as a `startStubAgent` handler. It ignores every other frame, such as
// a resize.
export function buildStubExecReplies(replies: StubExecReplies): StubAgentHandler {
  return (socket, _request, frames) => {
    const frame = frames.at(-1);

    if (frames.length === 1) {
      for (const reply of replies.started) {
        socket.write(reply);
      }
    } else if (frame?.type === FRAME_TYPES.stdin) {
      replies.onStdin?.(frame.payload);
    } else if (frame?.type === FRAME_TYPES.stdinEof) {
      replies.onStdinEnd?.();

      for (const reply of replies.exited) {
        socket.write(reply);
      }
    }
  };
}
