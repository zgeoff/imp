import { FRAME_TYPES, encodeFrame, encodeJsonFrame } from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

interface EchoExecScript {
  // the process id its STARTED reports
  readonly pid: number;

  // what the process writes to stderr once its stdin ends
  readonly stderr: Uint8Array;

  // how the process exits after that
  readonly exit: Readonly<{ code: number; signal: number }>;
}

// An agent whose exec acts like `cat`: STARTED, each stdin frame back as
// stdout, and on stdin EOF the stderr, EXIT and the end of the connection.
// Any op is an exec.
export function startStubEchoExecAgent(
  path: string,
  script: Readonly<EchoExecScript>,
  options: Readonly<{ stack?: Readonly<AsyncDisposableStack> }> = {},
) {
  return startStubAgent(
    path,
    (socket, _request, frames) => {
      const last = frames.at(-1);

      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: script.pid }));
      } else if (last?.type === FRAME_TYPES.stdin) {
        socket.write(encodeFrame(FRAME_TYPES.stdout, last.payload));
      } else if (last?.type === FRAME_TYPES.stdinEof) {
        socket.write(encodeFrame(FRAME_TYPES.stderr, script.stderr));
        socket.end(encodeJsonFrame(FRAME_TYPES.exit, script.exit));
      }
    },
    options,
  );
}
