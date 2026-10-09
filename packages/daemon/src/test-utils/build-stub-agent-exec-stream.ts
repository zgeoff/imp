import type { ExecEvent, ExecStream } from '../agent-client/exec-stream';

type StreamFields = Pick<
  ExecStream,
  'pid' | 'session' | 'created' | 'groupKill' | 'output' | 'stdinDrained'
>;

// The agent's exec stream as an `/exec` session reads it: the test feeds its
// events, which end after an exit or a detached, or early on `drop`, as a
// lost agent connection does. `input` records each call made on it.
export function buildStubAgentExecStream(fields: Partial<StreamFields> = {}) {
  const queue: (ExecEvent | null)[] = [];
  const input: string[] = [];
  const waiting: { wake: (() => void) | null } = { wake: null };

  const writeEvent = (entry: ExecEvent | null): void => {
    queue.push(entry);
    waiting.wake?.();
  };

  const readNext = async (): Promise<ExecEvent | null> => {
    for (;;) {
      if (queue.length > 0) {
        return queue.shift() ?? null;
      }

      await new Promise<void>((resolve) => {
        waiting.wake = resolve;
      });
    }
  };

  const stream: ExecStream = {
    pid: 7,
    session: null,
    created: false,
    groupKill: false,
    output: null,
    stdinDrained: () => Promise.resolve(),
    ...fields,
    writeStdin: (data) => {
      input.push(`stdin:${new TextDecoder().decode(data)}`);
    },
    closeStdin: () => {
      input.push('eof');
    },
    resize: (cols, rows) => {
      input.push(`resize:${String(cols)}x${String(rows)}`);
    },
    sendSignal: (signal) => {
      input.push(`signal:${String(signal)}`);
    },
    events: () => readEvents(readNext),
    close: () => {
      input.push('close');
    },
  };

  return {
    stream,
    input,
    emitEvent: (event: ExecEvent): void => {
      writeEvent(event);
    },
    drop: (): void => {
      writeEvent(null);
    },
  };
}

// the events up to an exit or a detached; null ends them without one
async function* readEvents(
  readNext: () => Promise<ExecEvent | null>,
): AsyncGenerator<ExecEvent, void, undefined> {
  for (;;) {
    const event = await readNext();

    if (event === null) {
      return;
    }

    yield event;

    if (event.type === 'exit' || event.type === 'detached') {
      return;
    }
  }
}
