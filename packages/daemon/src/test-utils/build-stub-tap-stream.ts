import type { SessionOutput } from '@imp/api';
import type { ExecEvent, ExecStream } from '../agent-client/exec-stream';

interface TapState {
  closed: boolean;
  dropped: boolean;
  finished: boolean;
}

interface TapSource {
  readonly queue: ExecEvent[];
  readonly state: TapState;
  readonly waiting: { wake: (() => void) | null };
}

// the events `readNext` gives until it gives null, or up to an exit or a
// detached, as the agent client's readExecEvents ends; `setFinished` marks
// the reader done with them, at the end or when the reader leaves its loop
async function* readTapEvents(
  readNext: () => Promise<ExecEvent | null>,
  setFinished: () => void,
): AsyncGenerator<ExecEvent, void, undefined> {
  try {
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
  } finally {
    setFinished();
  }
}

// A session tap as `openTapStream` hands one to impd, fed by the test. `drop`
// ends it as a sleep's vsock reset does; `state.finished` is set once the
// reader is done with it, at the end or by leaving its loop.
export function buildStubTapStream(output: SessionOutput) {
  const source: TapSource = {
    queue: [],
    state: { closed: false, dropped: false, finished: false },
    waiting: { wake: null },
  };

  const wake = (): void => {
    source.waiting.wake?.();
    source.waiting.wake = null;
  };

  // the next queued event, or null once impd closed the tap or, with the
  // queue read, the connection dropped
  const readNext = async (): Promise<ExecEvent | null> => {
    for (;;) {
      if (source.state.closed) {
        return null;
      }

      const event = source.queue.shift();

      if (event !== undefined) {
        return event;
      }

      if (source.state.dropped) {
        return null;
      }

      await new Promise<void>((resolve) => {
        source.waiting.wake = resolve;
      });
    }
  };

  const setFinished = (): void => {
    source.state.finished = true;
  };

  const stream: ExecStream = {
    pid: 1,
    session: 'main',
    created: false,
    groupKill: false,
    output,
    writeStdin: () => {},
    stdinDrained: () => Promise.resolve(),
    closeStdin: () => {},
    resize: () => {},
    sendSignal: () => {},
    events: () => readTapEvents(readNext, setFinished),
    close: () => {
      source.state.closed = true;

      wake();
    },
  };

  return {
    stream,
    state: source.state,
    emitEvent: (event: ExecEvent): void => {
      source.queue.push(event);

      wake();
    },
    write: (text: string): void => {
      source.queue.push({ type: 'stdout', data: new TextEncoder().encode(text) });

      wake();
    },
    drop: (): void => {
      source.state.dropped = true;

      wake();
    },
  };
}
