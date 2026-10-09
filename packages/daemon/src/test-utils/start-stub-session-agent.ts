import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import * as z from 'zod';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '../agent-client/frame-codec';
import { startStubAgent } from './start-stub-agent';

const ResumeFromSchema = z.object({ execution_generation: z.string(), offset: z.number() });

// what the agent reads of a request
const RequestSchema = z.looseObject({
  op: z.string(),
  argv: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
  tty: z.boolean().optional(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  session: z.string().optional(),
  log: z.boolean().optional(),
  resume_from: ResumeFromSchema.optional(),
});

export type StubSessionRequest = z.infer<typeof RequestSchema>;

type StubResumeFrom = Readonly<z.infer<typeof ResumeFromSchema>>;

// what a start reads of an exec with a session name
type StubStart = Readonly<{
  tty?: boolean;
  argv?: readonly string[];
  cols?: number;
  rows?: number;
  log?: boolean;
  resume?: StubResumeFrom;
}>;

interface StubExit {
  readonly code: number;
  readonly signal: number;
}

// a generation whose process ended and that left its name, as
// agent/internal/session keeps it for STARTED and NO_SESSION
interface StubPrevious {
  readonly execution_generation: string;
  readonly end: number;
  readonly exit: StubExit;
}

// one run of a session: its output generation and bytes, the one viewer
// attached to it, its taps, and its exit once its process ended
interface StubRun {
  readonly generation: string;
  readonly argv: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly isLogged: boolean;
  readonly startedUnixMs: number;
  readonly taps: Set<Socket>;
  output: Buffer;
  viewer: Socket | null;
  exit: StubExit | null;
}

interface StubSessionAgentOptions {
  // the agent's boot, in the uuid form impd checks before it names a log
  // path; one fixed boot by default
  readonly bootId?: string;

  // closes the agent; at the test's end by default
  readonly stack?: Readonly<AsyncDisposableStack>;
}

function sendError(socket: Socket, error: Readonly<Record<string, unknown>>): void {
  socket.end(encodeJsonFrame(FRAME_TYPES.response, { error }));
}

// A guest agent at `path` that runs sessions as agent/internal/session's
// Manager does. It keeps every output byte from offset 0, so a resume never
// meets a gap.
export async function startStubSessionAgent(
  path: string,
  options: Readonly<StubSessionAgentOptions> = {},
) {
  const bootId = options.bootId ?? '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

  const runs = new Map<string, StubRun>();
  const previous = new Map<string, StubPrevious>();

  const connections = { open: 0 };

  const listActivity = () => ({
    tcp_established: 0,
    exec_sessions: connections.open,
    load1: 0,
    sessions: [...runs]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, run]) => ({
        name,
        pid: 9,
        argv: run.argv,
        state: run.exit === null ? 'running' : 'exited',
        attached: run.viewer !== null,
        cols: run.cols,
        rows: run.rows,
        started_unix_ms: run.startedUnixMs,

        // left out of the JSON while undefined, as the agent omits them
        exit: run.exit ?? undefined,
        execution_generation: run.generation,
        boot_id: bootId,
        end: run.output.length,
        log: run.isLogged ? true : undefined,
      })),
  });

  const sendNoSession = (socket: Socket, session: string): void => {
    const last = previous.get(session);

    sendError(socket, {
      code: 'NO_SESSION',
      message: `no session "${session}"`,
      data: { boot_id: bootId, ...(last !== undefined && { previous: last }) },
    });
  };

  const sendInvalidResume = (socket: Socket, offset: number, end: number): void => {
    sendError(socket, {
      code: 'INVALID_RESUME',
      message: `offset ${String(offset)} is past the end of the output, ${String(end)}`,
      data: { end, buffer_start: 0 },
    });
  };

  // the session's run leaves its name, and, once its process ended, its
  // generation becomes the name's previous
  const removeRun = (session: string): void => {
    const run = runs.get(session);

    if (run === undefined) {
      return;
    }

    runs.delete(session);

    if (run.exit !== null) {
      previous.set(session, {
        execution_generation: run.generation,
        end: run.output.length,
        exit: run.exit,
      });
    }
  };

  // the EXIT as `socket`'s last frame; the run is over once a viewer got it
  const sendExit = (session: string, socket: Socket, exit: StubExit): void => {
    socket.end(encodeJsonFrame(FRAME_TYPES.exit, exit));

    removeRun(session);
  };

  // where a connection to the session's run starts: the whole output
  // without a resume, or from the offset a resume names; null for an offset
  // past the end
  const readPlace = (session: string, resume: StubResumeFrom | undefined) => {
    const run = runs.get(session);

    if (run === undefined) {
      throw new Error(`no run of session ${session}`);
    }

    const output = {
      boot_id: bootId,
      execution_generation: run.generation,
      buffer_start: 0,
      end: run.output.length,
      offset: 0,
      prelude: 0,
      ...(run.isLogged && { log: true }),
    };

    if (resume === undefined) {
      return output;
    }

    if (resume.execution_generation !== run.generation) {
      return {
        ...output,
        resume: {
          kind: 'generation_changed',
          execution_generation: run.generation,
          first_offset: 0,
        },
      };
    }

    if (resume.offset > run.output.length) {
      return null;
    }

    return { ...output, offset: resume.offset, resume: { kind: 'exact' } };
  };

  // STARTED, the output the resume asks for, then the EXIT of an exited run
  // or live output to this viewer, which takes the run over
  const openViewer = (
    socket: Socket,
    session: string,
    resume: StubResumeFrom | undefined,
    created: boolean,
  ): void => {
    const run = runs.get(session);

    if (run === undefined) {
      sendNoSession(socket, session);

      return;
    }

    const output = readPlace(session, resume);

    if (output === null) {
      sendInvalidResume(socket, resume?.offset ?? 0, run.output.length);

      return;
    }

    const last = previous.get(session);

    run.viewer?.end(encodeJsonFrame(FRAME_TYPES.detached, { reason: 'taken_over' }));
    run.viewer = null;

    socket.write(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 9,
        session,
        ...(created && { created: true }),
        output: { ...output, ...(last !== undefined && { previous: last }) },
      }),
    );

    const data = run.output.subarray(output.offset);

    if (data.length > 0) {
      socket.write(encodeFrame(FRAME_TYPES.stdout, data));
    }

    if (run.exit !== null) {
      sendExit(session, socket, run.exit);

      return;
    }

    run.viewer = socket;

    socket.on('close', () => {
      if (run.viewer === socket) {
        run.viewer = null;
      }
    });
  };

  // exec with a session name: start the run unless it runs, or a resume
  // names its generation; an exited run gives its name to the new one
  const startSession = (socket: Socket, session: string, start: StubStart): void => {
    if (start.tty !== true) {
      sendError(socket, { code: 'BAD_REQUEST', message: 'a session needs a tty' });

      return;
    }

    const found = runs.get(session);

    if (
      found !== undefined &&
      (found.exit === null || found.generation === start.resume?.execution_generation)
    ) {
      openViewer(socket, session, start.resume, false);

      return;
    }

    removeRun(session);

    runs.set(session, {
      generation: randomBytes(16).toString('hex'),
      argv: start.argv ?? [],
      cols: start.cols ?? 0,
      rows: start.rows ?? 0,
      isLogged: start.log === true,
      startedUnixMs: Date.now(),
      taps: new Set(),
      output: Buffer.alloc(0),
      viewer: null,
      exit: null,
    });

    openViewer(socket, session, start.resume, true);
  };

  // session.tap: STARTED and the raw output from the resume or the start,
  // then live output; a tap is never the viewer
  const openTap = (socket: Socket, session: string, resume: StubResumeFrom | undefined): void => {
    const run = runs.get(session);

    if (run === undefined) {
      sendNoSession(socket, session);

      return;
    }

    if (!run.isLogged) {
      sendError(socket, { code: 'BAD_REQUEST', message: `session "${session}" keeps no log` });

      return;
    }

    const output = readPlace(session, resume);

    if (output === null) {
      sendInvalidResume(socket, resume?.offset ?? 0, run.output.length);

      return;
    }

    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9, session, output }));

    const data = run.output.subarray(output.offset);

    if (data.length > 0) {
      socket.write(encodeFrame(FRAME_TYPES.stdout, data));
    }

    if (run.exit !== null) {
      socket.end(encodeJsonFrame(FRAME_TYPES.exit, run.exit));

      return;
    }

    run.taps.add(socket);

    socket.on('close', () => {
      run.taps.delete(socket);
    });
  };

  // a connection the activity counts: exec, exec.outer and session.attach,
  // and exec with a session, for as long as it is open
  const countConnection = (socket: Socket): void => {
    connections.open += 1;

    socket.on('close', () => {
      connections.open -= 1;
    });
  };

  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  const agent = await startStubAgent(
    path,
    (socket, request, frames) => {
      if (frames.length > 1) {
        return;
      }

      const parsed = RequestSchema.parse(decodeJsonPayload(request));
      const session = parsed.session ?? '';

      if (parsed.op === 'activity') {
        socket.write(encodeJsonFrame(FRAME_TYPES.response, listActivity()));

        return;
      }

      if (parsed.op === 'session.tap') {
        openTap(socket, session, parsed.resume_from);

        return;
      }

      countConnection(socket);

      if (parsed.op === 'session.attach') {
        openViewer(socket, session, parsed.resume_from, false);

        return;
      }

      if (parsed.session === undefined) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));

        return;
      }

      startSession(socket, session, {
        ...(parsed.tty !== undefined && { tty: parsed.tty }),
        ...(parsed.argv !== undefined && { argv: parsed.argv }),
        ...(parsed.cols !== undefined && { cols: parsed.cols }),
        ...(parsed.rows !== undefined && { rows: parsed.rows }),
        ...(parsed.log !== undefined && { log: parsed.log }),
        ...(parsed.resume_from !== undefined && { resume: parsed.resume_from }),
      });
    },
    closeWith,
  );

  return {
    close: agent.close,

    // the exec requests the agent got, not its other requests
    readExecs: (): StubSessionRequest[] =>
      agent.received
        .map((frame) => RequestSchema.parse(decodeJsonPayload(frame)))
        .filter((frame) => frame.op === 'exec'),

    // a session's current run, or undefined before it started and once a
    // viewer got its EXIT
    readRun: (session: string) => {
      const run = runs.get(session);

      return run === undefined
        ? undefined
        : {
            generation: run.generation,
            state: run.exit === null ? ('running' as const) : ('exited' as const),
            isAttached: run.viewer !== null,
          };
    },

    // the run's process exits: an attached viewer gets the EXIT and the run
    // is over; with none, the run waits for a viewer to take the EXIT
    exitRun: (session: string, exit: StubExit): void => {
      const run = runs.get(session);

      if (run === undefined) {
        throw new Error(`no run of session ${session}`);
      }

      run.exit = exit;

      for (const tapped of run.taps) {
        tapped.end(encodeJsonFrame(FRAME_TYPES.exit, exit));
      }

      run.taps.clear();

      const viewer = run.viewer;

      run.viewer = null;

      // a viewer whose connection already went leaves the EXIT to the next
      if (viewer !== null && !viewer.destroyed) {
        sendExit(session, viewer, exit);
      }
    },

    // output of the run: the agent keeps it, and sends it to the viewer and
    // the taps attached now
    writeOutput: (session: string, data: Uint8Array): void => {
      const run = runs.get(session);

      if (run === undefined) {
        throw new Error(`no run of session ${session}`);
      }

      run.output = Buffer.concat([run.output, data]);

      for (const reader of [run.viewer, ...run.taps]) {
        reader?.write(encodeFrame(FRAME_TYPES.stdout, data));
      }
    },

    // a cold boot: the guest's sessions, and what it knew of ended ones,
    // are gone
    clearRuns: (): void => {
      runs.clear();
      previous.clear();
    },
  };
}
