import type { DialEvent, DialStream, DialTarget } from '../agent-client/dial-stream';
import type { AgentExecRequest, ExecEvent, ExecStream } from '../agent-client/exec-stream';
import type { ImpRecord } from '../db/imps';
import { createActivityTracker } from '../imps/activity-tracker';
import type { SshBackend } from './ssh-connection-context';

export const FAKE_IMP: ImpRecord = {
  id: 'imp-box',
  name: 'box',
  imageId: 'image',
  state: 'running',
  vcpus: 2,
  memoryMib: 512,
  slot: 1,
  ip: '10.66.0.6',
  createdAt: new Date(0),
  lastActiveAt: new Date(0),
  sleptAt: null,
  holdUntil: null,
  error: null,
  pid: 100,
  firecrackerVersion: 'v1.17.0',
  httpPort: 8080,
};

// events a fake stream yields, in order; null ends the stream
interface EventQueue<T> {
  readonly emit: (event: T | null) => void;
  readonly next: () => Promise<T | null>;
}

function createEventQueue<T>(): EventQueue<T> {
  const events: (T | null)[] = [];
  const waiter: { wake: (() => void) | null } = { wake: null };

  return {
    emit: (event) => {
      events.push(event);
      waiter.wake?.();
    },
    next: async () => {
      while (events.length === 0) {
        await new Promise<void>((resolve) => {
          waiter.wake = resolve;
        });
      }

      return events.shift() ?? null;
    },
  };
}

async function* readEvents<T>(next: () => Promise<T | null>): AsyncGenerator<T, void, undefined> {
  for (;;) {
    const event = await next();

    if (event === null) {
      return;
    }

    yield event;
  }
}

// a program the gateway started; the test feeds its output
interface FakeExec {
  readonly request: AgentExecRequest;
  readonly feature: string | undefined;
  readonly stdin: readonly string[];
  readonly resizes: readonly string[];
  readonly signals: readonly number[];
  readonly emit: (event: ExecEvent | null) => void;
}

// a dial the gateway opened; it answers the whole request once the client
// half-closes, as an HTTP server would
interface FakeDial {
  readonly target: DialTarget;
  readonly input: readonly string[];
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// impd's side of the gateway in memory: one imp, wakes that a test can
// fail, and agent streams it scripts through `onExec`
export function createFakeSshBackend() {
  const execs: FakeExec[] = [];
  const dials: FakeDial[] = [];
  const tracker = createActivityTracker();

  const fake: {
    wakes: number;
    wakeError: Error | null;
    execError: Error | null;
    dialError: Error | null;
    onExec: ((exec: FakeExec) => void) | null;
  } = { wakes: 0, wakeError: null, execError: null, dialError: null, onExec: null };

  const openExec: SshBackend['openExec'] = (_name, request, feature) => {
    if (fake.execError !== null) {
      return Promise.reject(fake.execError);
    }

    const queue = createEventQueue<ExecEvent>();
    const stdin: string[] = [];
    const resizes: string[] = [];
    const signals: number[] = [];
    const exec: FakeExec = { request, feature, stdin, resizes, signals, emit: queue.emit };

    execs.push(exec);
    fake.onExec?.(exec);

    const stream: ExecStream = {
      pid: 42,
      session: null,
      created: false,
      writeStdin: (data) => {
        stdin.push(decoder.decode(data));
      },
      stdinDrained: () => Promise.resolve(),
      closeStdin: () => {
        stdin.push('<eof>');
      },
      resize: (cols, rows) => {
        resizes.push(`${String(cols)}x${String(rows)}`);
      },
      sendSignal: (signal) => {
        signals.push(signal);
      },
      events: () => readEvents(queue.next),
      close: () => {
        queue.emit(null);
      },
    };

    return Promise.resolve(stream);
  };

  const openDial: SshBackend['openDial'] = (_name, target) => {
    if (fake.dialError !== null) {
      return Promise.reject(fake.dialError);
    }

    const queue = createEventQueue<DialEvent>();
    const input: string[] = [];
    const dial: FakeDial = { target, input };

    dials.push(dial);

    const stream: DialStream = {
      write: (data) => {
        input.push(decoder.decode(data));
      },
      drained: () => Promise.resolve(),
      end: () => {
        queue.emit({ type: 'data', data: encoder.encode(`got ${input.join('')}`) });
        queue.emit({ type: 'eof' });
        queue.emit(null);
      },
      events: () => readEvents(queue.next),
      close: () => {
        queue.emit(null);
      },
    };

    return Promise.resolve(stream);
  };

  const backend: SshBackend = {
    findImp: (name) => {
      const found = name === FAKE_IMP.name ? FAKE_IMP : undefined;

      return Promise.resolve(found);
    },
    requireRunning: () => {
      fake.wakes += 1;

      if (fake.wakeError !== null) {
        return Promise.reject(fake.wakeError);
      }

      return Promise.resolve({ imp: FAKE_IMP, wokeMs: null });
    },
    tracker,
    recordActivity: () => Promise.resolve(),
    openExec,
    openDial,
  };

  return { backend, fake, execs, dials, tracker };
}
