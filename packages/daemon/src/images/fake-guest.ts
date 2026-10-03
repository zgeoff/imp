import type { AgentExecRequest, ExecEvent, ExecStream } from '../agent-client/exec-stream';

export interface FakeRun {
  readonly argv: readonly string[];

  // resolves with all of stdin once the exec closes it
  readonly readStdin: () => Promise<Uint8Array>;
}

export interface FakeAnswer {
  readonly stdout?: string | readonly Uint8Array[];
  readonly stderr?: string;
  readonly code?: number;

  // after its output, no exit: the exec stays open until impd closes it
  readonly stall?: boolean;
}

const encoder = new TextEncoder();

interface FakeRecord {
  readonly argv: readonly string[];
  readonly signals: number[];
  closed: boolean;
}

// the answer's output, then its exit; nothing once the exec is closed
async function* readFakeEvents(
  answering: Promise<FakeAnswer | null>,
  closing: Promise<null>,
  isClosed: () => boolean,
): AsyncGenerator<ExecEvent, void, undefined> {
  const answered = await answering;

  if (answered === null) {
    return;
  }

  const stdout =
    typeof answered.stdout === 'string' ? [encoder.encode(answered.stdout)] : answered.stdout;

  for (const data of stdout ?? []) {
    if (isClosed()) {
      return;
    }

    yield { type: 'stdout', data };
  }

  if (answered.stderr !== undefined) {
    yield { type: 'stderr', data: encoder.encode(answered.stderr) };
  }

  if (answered.stall === true) {
    await closing;

    return;
  }

  yield { type: 'exit', code: answered.code ?? 0, signal: 0 };
}

// A builder's agent for tests: each exec gets `answer`'s output, then its
// exit. Records each exec's argv, the signals it got and when it closed.
export function createFakeGuest(answer: (run: FakeRun) => Promise<FakeAnswer> | FakeAnswer) {
  const runs: FakeRecord[] = [];

  const open = (request: AgentExecRequest): Promise<ExecStream> => {
    const record: FakeRecord = { argv: request.argv, signals: [], closed: false };
    const stdin: Uint8Array[] = [];
    const stdinDone = Promise.withResolvers<Uint8Array>();
    const closed = Promise.withResolvers<null>();

    runs.push(record);

    const answering = Promise.race([
      Promise.resolve(answer({ argv: request.argv, readStdin: () => stdinDone.promise })),
      closed.promise,
    ]);

    return Promise.resolve({
      pid: runs.length,
      session: null,
      created: false,
      groupKill: true,
      output: null,
      writeStdin: (data) => {
        stdin.push(data);
      },
      stdinDrained: () => Promise.resolve(),
      closeStdin: () => {
        stdinDone.resolve(Buffer.concat(stdin));
      },
      resize: () => {},
      sendSignal: (signal) => {
        record.signals.push(signal);
      },
      events: () => readFakeEvents(answering, closed.promise, () => record.closed),
      close: () => {
        record.closed = true;

        closed.resolve(null);
      },
    });
  };

  return { open, runs };
}
