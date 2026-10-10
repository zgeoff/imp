import type { ExecEvent, ExecStream } from '../agent-client/exec-stream';

type StreamFields = Pick<
  ExecStream,
  'pid' | 'session' | 'created' | 'groupKill' | 'output' | 'stdinDrained'
>;

// The agent's exec stream as an `/exec` session reads it, fed by the test.
// `drop` is a lost agent connection; `close` destroys it as the real one
// does. `input` records each call made on it.
export function buildStubAgentExecStream(fields: Partial<StreamFields> = {}) {
  const queue: ExecEvent[] = [];
  const input: string[] = [];
  const waiting: { wake: (() => void) | null } = { wake: null };
  const connection = { ended: false };

  const wake = (): void => {
    waiting.wake?.();
    waiting.wake = null;
  };

  // a pending read ends once it has read the events fed before
  const stopConnection = (): void => {
    connection.ended = true;

    wake();
  };

  const readNext = async (): Promise<ExecEvent | null> => {
    for (;;) {
      const event = queue.shift();

      if (event !== undefined) {
        return event;
      }

      if (connection.ended) {
        return null;
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

      stopConnection();
    },
  };

  return {
    stream,
    input,

    // an event fed once the connection ended never arrives
    emitEvent: (event: ExecEvent): void => {
      if (!connection.ended) {
        queue.push(event);

        wake();
      }
    },
    drop: stopConnection,
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
