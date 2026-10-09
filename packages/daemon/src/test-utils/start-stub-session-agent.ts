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

// what the agent reads of an exec or activity request
const RequestSchema = z.looseObject({
  op: z.string(),
  env: z.array(z.string()).optional(),
  session: z.string().optional(),
  resume_from: z.object({ execution_generation: z.string() }).optional(),
});

export type StubSessionRequest = z.infer<typeof RequestSchema>;

// one run of a session: its output generation, the client attached to it,
// and whether its process exited
interface StubRun {
  readonly generation: string;
  viewer: Socket | null;
  state: 'running' | 'exited';
}

interface StubSessionAgentOptions {
  // the agent's boot, in the uuid form impd checks before it names a log
  // path; one fixed boot by default
  readonly bootId?: string;

  // closes the agent; at the test's end by default
  readonly stack?: Readonly<AsyncDisposableStack>;
}

// A guest agent at `path` that runs sessions as the real one does: a new
// name starts a run, a running one's name takes it over from its viewer, an
// exited run takes only a resume of its generation; `activity` lists all.
export async function startStubSessionAgent(
  path: string,
  options: Readonly<StubSessionAgentOptions> = {},
) {
  const bootId = options.bootId ?? '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

  const runs = new Map<string, StubRun>();

  const listActivity = () => ({
    tcp_established: 0,
    exec_sessions: runs.size,
    load1: 0,
    sessions: [...runs].map(([name, run]) => ({
      name,
      pid: 9,
      argv: ['sh'],
      state: run.state,
      attached: run.viewer !== null,
      cols: 80,
      rows: 24,
      started_unix_ms: 0,
      execution_generation: run.generation,
      boot_id: bootId,
      end: 0,
    })),
  });

  // `resumed`: the generation a resume asks for
  const startSession = (socket: Socket, session: string, resumed: string | undefined): void => {
    const found = runs.get(session);

    const known =
      found?.state === 'running' || (found !== undefined && found.generation === resumed)
        ? found
        : undefined;

    const run: StubRun = known ?? {
      generation: randomBytes(16).toString('hex'),
      viewer: null,
      state: 'running',
    };

    known?.viewer?.end(encodeJsonFrame(FRAME_TYPES.detached, { reason: 'taken_over' }));
    run.viewer = socket;

    runs.set(session, run);

    socket.write(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 9,
        session,
        created: known === undefined,
        output: {
          boot_id: bootId,
          execution_generation: run.generation,
          buffer_start: 0,
          end: 0,
          offset: 0,
          prelude: 0,
        },
      }),
    );
  };

  const closeWith = options.stack === undefined ? {} : { stack: options.stack };

  const agent = await startStubAgent(
    path,
    (socket, request, frames) => {
      if (frames.length > 1) {
        return;
      }

      const parsed = RequestSchema.parse(decodeJsonPayload(request));

      if (parsed.op === 'activity') {
        socket.write(encodeJsonFrame(FRAME_TYPES.response, listActivity()));
      } else if (parsed.session === undefined) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
      } else {
        startSession(socket, parsed.session, parsed.resume_from?.execution_generation);
      }
    },
    closeWith,
  );

  return {
    close: agent.close,

    // the exec requests the agent got, not its activity requests
    readExecs: (): StubSessionRequest[] =>
      agent.received
        .map((frame) => RequestSchema.parse(decodeJsonPayload(frame)))
        .filter((frame) => frame.op === 'exec'),

    // a session's current run, or undefined before it started
    readRun: (session: string) => {
      const run = runs.get(session);

      return run === undefined
        ? undefined
        : { generation: run.generation, state: run.state, isAttached: run.viewer !== null };
    },

    // the run's process exits while no client is attached
    exitRun: (session: string): void => {
      const run = runs.get(session);

      if (run === undefined) {
        throw new Error(`no run of session ${session}`);
      }

      run.state = 'exited';
      run.viewer = null;
    },

    // output of the run, sent to the client attached to it
    writeOutput: (session: string, data: Uint8Array): void => {
      const viewer = runs.get(session)?.viewer;

      if (viewer === null || viewer === undefined) {
        throw new Error(`no client attached to session ${session}`);
      }

      viewer.write(encodeFrame(FRAME_TYPES.stdout, data));
    },

    // a cold boot: the guest's sessions are gone
    clearRuns: (): void => {
      runs.clear();
    },
  };
}
