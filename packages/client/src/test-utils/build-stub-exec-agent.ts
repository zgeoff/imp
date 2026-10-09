import type { Socket } from 'node:net';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '@imp/daemon/src/agent-client/frame-codec';
import type { AgentFrame } from '@imp/daemon/src/agent-client/frame-codec';
import type { StubAgentHandler } from '@imp/daemon/src/test-utils/start-stub-agent';
import * as z from 'zod';

// the bytes `big` writes to each of stdout and stderr
export const STUB_FLOOD_BYTES = 512 * 1024;

// the boot and generation of the `counted` session, as the agent names them
export const STUB_BOOT_ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
export const STUB_GENERATION = 'd'.repeat(32);

// the end of the `counted` session's output, and of the `ended` one's
const OUTPUT_END = 100;

// what an exec or an attach asks the agent, in its wire form
const RequestSchema = z.looseObject({
  op: z.string(),
  argv: z.array(z.string()).optional(),
  session: z.string().optional(),
  kill_grace_ms: z.int().optional(),
  resume_from: z.object({ execution_generation: z.string(), offset: z.int() }).optional(),
});

type StubRequest = z.infer<typeof RequestSchema>;

const ResizeSchema = z.object({ cols: z.int(), rows: z.int() });
const SignalSchema = z.object({ signal: z.int() });

interface Run {
  readonly command: string;

  // the agent ended the run: an exit, a detach or an error
  ended: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* oxlint-disable prefer-readonly-parameter-types -- each step writes to the live socket of a run */

function writeText(socket: Socket, type: 8 | 9, text: string): void {
  socket.write(encodeFrame(type, encoder.encode(text)));
}

function stopRun(socket: Socket, run: Run, frame: Uint8Array): void {
  run.ended = true;

  socket.end(frame);
}

function sendRefusal(socket: Socket, run: Run, error: Readonly<Record<string, unknown>>): void {
  stopRun(socket, run, encodeJsonFrame(FRAME_TYPES.response, { error }));
}

function sendExit(socket: Socket, run: Run, code: number, signal: number): void {
  stopRun(socket, run, encodeJsonFrame(FRAME_TYPES.exit, { code, signal }));
}

// An exec, by argv[0]: `nope`, `fail`, `tick` and `big` answer at once;
// `cat`, `wait`, `old` (an agent from before the group kill) and /bin/sh
// run until a signal, ^C or a `cat`'s stdin ends
function startExec(socket: Socket, run: Run, request: StubRequest): void {
  if (run.command === 'nope') {
    sendRefusal(socket, run, { code: 'EXEC_FAILED', message: 'no such file' });

    return;
  }

  const groupKill = request.kill_grace_ms !== undefined && run.command !== 'old';

  socket.write(
    encodeJsonFrame(FRAME_TYPES.started, {
      pid: 42,
      ...(request.session !== undefined && { session: request.session, created: true }),
      ...(groupKill && { kill_grace_ms: request.kill_grace_ms }),
    }),
  );

  if (run.command === 'fail') {
    writeText(socket, FRAME_TYPES.stdout, 'out');
    writeText(socket, FRAME_TYPES.stderr, 'err');
    sendExit(socket, run, 3, 0);
  }

  if (run.command === 'tick') {
    writeText(socket, FRAME_TYPES.stdout, 'tick');
  }

  if (run.command === 'big') {
    for (let sent = 0; sent < STUB_FLOOD_BYTES; sent += 16_384) {
      socket.write(encodeFrame(FRAME_TYPES.stdout, new Uint8Array(16_384).fill(111)));
      socket.write(encodeFrame(FRAME_TYPES.stderr, new Uint8Array(16_384).fill(101)));
    }

    sendExit(socket, run, 0, 0);
  }
}

// An attach, by session: `main` runs until a write of `taken` detaches it,
// `counted` resumes at 95 of 100 and exits, `ended` exited earlier, and any
// other is not there
function startAttach(socket: Socket, run: Run, request: StubRequest): void {
  if ((request.resume_from?.offset ?? 0) > OUTPUT_END) {
    sendRefusal(socket, run, {
      code: 'INVALID_RESUME',
      message: 'past the end',
      data: { end: OUTPUT_END, buffer_start: 0 },
    });

    return;
  }

  if (request.session === 'counted') {
    socket.write(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 42,
        session: 'counted',
        created: false,
        output: {
          boot_id: STUB_BOOT_ID,
          execution_generation: STUB_GENERATION,
          buffer_start: 0,
          end: OUTPUT_END,
          offset: 95,
          prelude: 0,
          resume: { kind: 'exact' },
        },
      }),
    );

    writeText(socket, FRAME_TYPES.stdout, 'tail!');
    sendExit(socket, run, 0, 0);

    return;
  }

  if (request.session === 'ended') {
    sendRefusal(socket, run, {
      code: 'NO_SESSION',
      message: 'no session "ended"',
      data: {
        boot_id: STUB_BOOT_ID,
        previous: {
          execution_generation: STUB_GENERATION,
          end: OUTPUT_END,
          exit: { code: 0, signal: 0 },
        },
      },
    });

    return;
  }

  if (request.session !== 'main') {
    sendRefusal(socket, run, {
      code: 'NO_SESSION',
      message: `no session "${String(request.session)}"`,
    });

    return;
  }

  socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, session: 'main', created: false }));

  writeText(socket, FRAME_TYPES.stdout, 'replay');
}

// what a running command does with a frame from impd after its start
function readInput(
  socket: Socket,
  run: Run,
  frame: AgentFrame,
  writeInput: (entry: string) => void,
) {
  if (frame.type === FRAME_TYPES.stdin) {
    const text = decoder.decode(frame.payload);

    writeInput(text);

    if (run.command === 'cat') {
      socket.write(encodeFrame(FRAME_TYPES.stdout, frame.payload));
    }

    if ((run.command === 'wait' || run.command === '/bin/sh') && text.includes('\u0003')) {
      sendExit(socket, run, 130, 2);
    }

    if (run.command === 'attach main' && text === 'taken') {
      stopRun(socket, run, encodeJsonFrame(FRAME_TYPES.detached, { reason: 'taken_over' }));
    }
  }

  if (frame.type === FRAME_TYPES.stdinEof) {
    writeInput('eof');

    if (run.command === 'cat') {
      sendExit(socket, run, 0, 0);
    }
  }

  if (frame.type === FRAME_TYPES.resize) {
    const size = ResizeSchema.parse(decodeJsonPayload(frame));

    writeInput(`resize:${String(size.cols)}x${String(size.rows)}`);
  }

  if (frame.type === FRAME_TYPES.signal) {
    const signal = SignalSchema.parse(decodeJsonPayload(frame)).signal;

    writeInput(`signal:${String(signal)}`);
    sendExit(socket, run, 128 + signal, signal);
  }
}

/* oxlint-enable prefer-readonly-parameter-types */

// An imp's guest agent for exec and attach, for startStubAgent. It records
// each request, what each command got (stdin as text, `eof`, `resize:CxR`,
// `signal:N`), and each command whose connection impd closed as it ran.
export function buildStubExecAgent() {
  const requests: StubRequest[] = [];
  const input: string[] = [];
  const closed: string[] = [];

  const runs = new WeakMap<Socket, Run>();

  const writeInput = (entry: string): void => {
    input.push(entry);
  };

  const readFrame: StubAgentHandler = (socket, request, frames) => {
    const known = runs.get(socket);

    if (known !== undefined) {
      if (!known.ended) {
        readInput(socket, known, frames.at(-1) ?? request, writeInput);
      }

      return;
    }

    const parsed = RequestSchema.parse(decodeJsonPayload(request));

    const command =
      parsed.op === 'session.attach'
        ? `attach ${String(parsed.session)}`
        : (parsed.argv?.[0] ?? '');

    const run: Run = { command, ended: false };

    runs.set(socket, run);
    requests.push(parsed);

    // impd may close the connection while a command still writes, as a
    // client that stopped reading does
    socket.on('error', () => {});

    socket.on('close', () => {
      if (!run.ended) {
        closed.push(command);
      }
    });

    if (parsed.op === 'exec') {
      startExec(socket, run, parsed);
    } else if (parsed.op === 'session.attach') {
      startAttach(socket, run, parsed);
    } else {
      sendRefusal(socket, run, { code: 'UNKNOWN_OP', message: `unknown op ${parsed.op}` });
    }
  };

  return { requests, input, closed, readFrame };
}
