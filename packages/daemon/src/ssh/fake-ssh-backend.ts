import type { DialEvent, DialStream, DialTarget } from '../agent-client/dial-stream';
import type { AgentExecRequest, ExecEvent, ExecStream } from '../agent-client/exec-stream';
import type { GuestListener, ListenSpec } from '../agent-client/listener-stream';
import type { AuditActor } from '../auth/caller';
import type { ImpRecord } from '../db/imps';
import { createActivityTracker } from '../imps/activity-tracker';
import type { ImpRuntime } from '../imps/imp-runtime';
import type { SshBackend } from './ssh-connection-context';

export const FAKE_IMP: ImpRecord = {
  id: 'imp-box',
  name: 'box',
  imageId: 'image',
  state: 'running',
  vcpus: 2,
  memoryMib: 512,
  maxMemoryMib: 512,
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
  diskBytes: 34_359_738_368,
  isDiskGrowPending: false,
  cpu: { limit: null, weight: 100 },
  wakeCount: 0,
  awakeMs: 0,
  awakeSince: null,
  isIdentityResetPending: false,
  isTrustPending: false,
  publicAuth: null,
  moveState: null,
  jailUid: 900_000,
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

// a guest socket the gateway opened (ssh-agent or a remote forward); the
// test connects clients
interface FakeListener {
  readonly id: string;
  readonly spec: ListenSpec;
  readonly connect: (id: number) => void;

  // the agent connection ended, as after a forced sleep
  readonly end: () => void;
  readonly state: { closed: boolean };
}

// the relay for one guest client; the test sends what the client asks
interface FakeAccept {
  readonly listener: string;
  readonly id: number;
  readonly input: readonly string[];
  readonly send: (data: string) => void;
  readonly state: { closed: boolean };
}

// where a fake listener's socket is: an ssh-agent's, the path asked for, or
// none for a port
function readFakePath(spec: ListenSpec, id: string): string | null {
  if (spec.network === 'ssh-agent') {
    return `/run/imp/ssh-agent/${id}/agent.sock`;
  }

  return spec.network === 'unix' ? (spec.path ?? `/run/imp/forward/${id}/sock`) : null;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// impd's side of the gateway in memory: one imp, wakes that a test can
// fail, and agent streams it scripts through `onExec`
export function createFakeSshBackend() {
  const execs: FakeExec[] = [];
  const dials: FakeDial[] = [];
  const listeners: FakeListener[] = [];
  const accepts: FakeAccept[] = [];
  const tracker = createActivityTracker();

  // who each exec ran as, for the audit
  const actors: AuditActor[] = [];

  const fake: {
    wakes: number;

    // imp lookups by name, as a login makes them
    lookups: number;
    wakeError: Error | null;
    execError: Error | null;
    dialError: Error | null;
    listenError: Error | null;

    // the VM's pid; a test changes it to stand for a wake
    pid: number;
    onExec: ((exec: FakeExec) => void) | null;
  } = {
    pid: FAKE_IMP.pid ?? 0,
    wakes: 0,
    lookups: 0,
    wakeError: null,
    execError: null,
    dialError: null,
    listenError: null,
    onExec: null,
  };

  // the runtime's shape, so the fake also stands in for impd's imps
  const openExec: ImpRuntime['openExec'] = (_name, request, feature) => {
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
      groupKill: false,
      output: null,
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

  const openListener: SshBackend['openListener'] = (_name, spec) => {
    if (fake.listenError !== null) {
      return Promise.reject(fake.listenError);
    }

    const queue = createEventQueue<number>();
    const id = `fake${String(listeners.length + 1)}`;
    const state = { closed: false };

    listeners.push({
      id,
      spec,
      connect: queue.emit,
      end: () => {
        queue.emit(null);
      },
      state,
    });

    const listener: GuestListener = {
      path: readFakePath(spec, id),
      port: spec.network === 'tcp' ? spec.port || 40_000 + listeners.length : null,
      id,
      connections: () => readEvents(queue.next),
      close: () => {
        state.closed = true;

        queue.emit(null);
      },
    };

    return Promise.resolve(listener);
  };

  const openAccept: SshBackend['openAccept'] = (_name, listener, id) => {
    const queue = createEventQueue<DialEvent>();
    const input: string[] = [];
    const state = { closed: false };

    accepts.push({
      listener,
      id,
      input,
      send: (data) => {
        queue.emit({ type: 'data', data: encoder.encode(data) });
      },
      state,
    });

    const stream: DialStream = {
      write: (data) => {
        input.push(decoder.decode(data));
      },
      drained: () => Promise.resolve(),
      end: () => {
        queue.emit(null);
      },
      events: () => readEvents(queue.next),
      close: () => {
        state.closed = true;

        queue.emit(null);
      },
    };

    return Promise.resolve(stream);
  };

  const backend: SshBackend & Pick<ImpRuntime, 'openExec'> = {
    findImp: (name) => {
      fake.lookups += 1;

      const found = name === FAKE_IMP.name ? FAKE_IMP : undefined;

      return Promise.resolve(found);
    },
    requireRunning: () => {
      fake.wakes += 1;

      if (fake.wakeError !== null) {
        return Promise.reject(fake.wakeError);
      }

      return Promise.resolve({ imp: { ...FAKE_IMP, pid: fake.pid }, wokeMs: null });
    },
    tracker,
    recordActivity: () => Promise.resolve(),
    openExec: (name, request, feature, actor?: AuditActor) => {
      if (actor !== undefined) {
        actors.push(actor);
      }

      return openExec(name, request, feature);
    },
    openDial,
    openListener,
    openAccept,
  };

  return { backend, fake, actors, execs, dials, listeners, accepts, tracker };
}
