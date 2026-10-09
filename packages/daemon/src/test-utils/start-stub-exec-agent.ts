import type { Socket } from 'node:net';
import * as z from 'zod';
import type { AgentExecRequest, ExecEvent, ExecStream } from '../agent-client/exec-stream';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '../agent-client/frame-codec';
import type { AgentFrame } from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

// the exec request as the agent's wire carries it
const ExecRequestSchema = z.object({
  op: z.string(),
  argv: z.array(z.string()).default([]),
  env: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  tty: z.boolean().default(false),
  cols: z.int().optional(),
  rows: z.int().optional(),
  user: z.string().optional(),
  session: z.string().optional(),
  kill_grace_ms: z.int().optional(),
});

const SignalSchema = z.object({ signal: z.int() });

// the agent's maxKillGrace, as the host's API caps it too
const MAX_KILL_GRACE_MS = 60_000;

// what runs the commands: buildStubExecGuest's openExec
interface StubExecTarget {
  readonly openExec: (name: string, request: Readonly<AgentExecRequest>) => Promise<ExecStream>;
}

// An imp's guest agent at `path` for exec: each `exec` request becomes an
// openExec on `guest`, its events go back as frames and stdin and signals
// reach the stream; a dropped connection closes it, other ops get UNKNOWN_OP.
export function startStubExecAgent(path: string, guest: StubExecTarget) {
  const streams = new WeakMap<Socket, Promise<ExecStream>>();

  const sendEvents = async (
    socket: Socket,
    pending: Promise<ExecStream>,
    killGraceMs: number,
  ): Promise<void> => {
    const stream = await pending;

    // as the agent's STARTED: the clamped grace of a guest that kills the
    // group, and a session's name, with `created` only when true
    socket.write(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: stream.pid,
        ...(stream.session !== null && { session: stream.session }),
        ...(stream.session !== null && stream.created && { created: true }),
        ...(stream.groupKill && killGraceMs > 0 && { kill_grace_ms: killGraceMs }),
      }),
    );

    for await (const event of stream.events()) {
      if (!socket.destroyed) {
        socket.write(encodeEventFrame(event));
      }
    }
  };

  const sendInput = async (pending: Promise<ExecStream>, frame: AgentFrame): Promise<void> => {
    const stream = await pending;

    if (frame.type === FRAME_TYPES.stdin) {
      stream.writeStdin(frame.payload);
    } else if (frame.type === FRAME_TYPES.stdinEof) {
      stream.closeStdin();
    } else if (frame.type === FRAME_TYPES.signal) {
      stream.sendSignal(SignalSchema.parse(decodeJsonPayload(frame)).signal);
    }
  };

  return startStubAgent(path, (socket, request, frames) => {
    const pending = streams.get(socket);
    const last = frames.at(-1);

    if (pending !== undefined && last !== undefined && frames.length > 1) {
      void sendInput(pending, last);

      return;
    }

    const parsed = ExecRequestSchema.parse(decodeJsonPayload(request));

    if (parsed.op !== 'exec') {
      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, {
          error: { code: 'UNKNOWN_OP', message: `unknown op ${parsed.op}` },
        }),
      );

      return;
    }

    const opening = guest.openExec('', {
      argv: parsed.argv,
      tty: parsed.tty,
      ...(parsed.env !== undefined && { env: parsed.env }),
      ...(parsed.cwd !== undefined && { cwd: parsed.cwd }),
      ...(parsed.cols !== undefined && { cols: parsed.cols }),
      ...(parsed.rows !== undefined && { rows: parsed.rows }),
      ...(parsed.user !== undefined && { user: parsed.user }),
      ...(parsed.session !== undefined && { session: parsed.session }),
      ...(parsed.kill_grace_ms !== undefined && { killGraceMs: parsed.kill_grace_ms }),
    });

    streams.set(socket, opening);

    socket.once('close', () => {
      void stopStream(opening);
    });

    void sendEvents(socket, opening, readKillGraceMs(parsed));
  });
}

function encodeEventFrame(event: Readonly<ExecEvent>): Uint8Array {
  if (event.type === 'exit') {
    return encodeJsonFrame(FRAME_TYPES.exit, { code: event.code, signal: event.signal });
  }

  if (event.type === 'detached') {
    return encodeJsonFrame(FRAME_TYPES.detached, { reason: event.reason });
  }

  const type = event.type === 'stdout' ? FRAME_TYPES.stdout : FRAME_TYPES.stderr;

  return encodeFrame(type, event.data);
}

async function stopStream(pending: Promise<ExecStream>): Promise<void> {
  const stream = await pending;

  stream.close();
}

// the agent's killGrace (agent/internal/exec/group.go): off for a tty exec
// or none asked, else capped at a minute
function readKillGraceMs(request: Readonly<{ tty: boolean; kill_grace_ms?: number | undefined }>) {
  if (request.tty || request.kill_grace_ms === undefined || request.kill_grace_ms <= 0) {
    return 0;
  }

  return Math.min(request.kill_grace_ms, MAX_KILL_GRACE_MS);
}
