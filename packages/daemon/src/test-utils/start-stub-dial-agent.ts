import { FRAME_TYPES, encodeFrame, encodeJsonFrame } from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

// An agent whose dial reaches a target that answers once the request is
// whole: `{ ok: true }`, then on stdin EOF `answer` of all the stdin as one
// stdout frame, STDOUT_EOF and the end of the connection. Any op is a dial.
export function startStubDialAgent(
  path: string,
  answer: (asked: string) => string,
  options: Readonly<{ stack?: Readonly<AsyncDisposableStack> }> = {},
) {
  return startStubAgent(
    path,
    (socket, _request, frames) => {
      const last = frames.at(-1);

      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
      } else if (last?.type === FRAME_TYPES.stdinEof) {
        const asked = frames
          .filter((frame) => frame.type === FRAME_TYPES.stdin)
          .map((frame) => new TextDecoder().decode(frame.payload))
          .join('');

        const reply = new TextEncoder().encode(answer(asked));

        socket.write(encodeFrame(FRAME_TYPES.stdout, reply));
        socket.end(encodeFrame(FRAME_TYPES.stdoutEof));
      }
    },
    options,
  );
}
