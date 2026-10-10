import type { DialEvent, DialStream, DialTarget } from '../agent-client/dial-stream';
import type { AgentExecRequest, ExecEvent, ExecStream } from '../agent-client/exec-stream';
import type { GuestListener, ListenSpec } from '../agent-client/listener-stream';
import { buildNotFoundError } from '../api-errors';
import type { AuditActor } from '../auth/caller';
import type { ImpRecord } from '../db/imps';
import { createActivityTracker } from '../imps/activity-tracker';
import type { ConnectionKind } from '../imps/activity-tracker';
import type { ImpRuntime } from '../imps/imp-runtime';
import type { SshBackend } from '../ssh/ssh-connection-context';

// events a stub stream yields, in order; null ends the stream
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
interface StubExec {
  readonly request: AgentExecRequest;
  readonly feature: string | undefined;
  readonly stdin: readonly string[];
  readonly resizes: readonly string[];
  readonly signals: readonly number[];
  readonly emit: (event: ExecEvent | null) => void;
}

// a dial the gateway opened; it answers `got <input>` once the client
// half-closes, as an HTTP server answers a whole request
interface StubDial {
  readonly target: DialTarget;
  readonly kind: ConnectionKind;
  readonly input: readonly string[];
}

// a guest socket the gateway opened (ssh-agent or a remote forward); the
// test connects guest clients to it
interface StubListener {
  readonly id: string;
  readonly spec: ListenSpec;
  readonly kind: ConnectionKind | null;
  readonly connect: (id: number) => void;

  // the agent connection ended, as after a forced sleep
  readonly end: () => void;
  readonly state: { closed: boolean };
}

// the relay for one guest client; the test sends what the client asks. The
// gateway's half-close lands in `input` as `<eof>`; the relay ends once both
// sides have closed, as the agent ends it
interface StubAccept {
  readonly listener: string;
  readonly id: number;
  readonly kind: ConnectionKind;
  readonly input: readonly string[];
  readonly send: (data: string) => void;

  // the guest client closed its side
  readonly sendEof: () => void;

  // ended: the relay sent its last event, as the agent ends it
  readonly state: { closed: boolean; ended: boolean };
}

// where a stub listener's socket is, as the agent picks it: an ssh-agent's,
// the path asked for, or none for a port
function readStubPath(spec: ListenSpec, id: string): string | null {
  if (spec.network === 'ssh-agent') {
    return `/run/imp/ssh-agent/${id}/agent.sock`;
  }

  return spec.network === 'unix' ? (spec.path ?? `/run/imp/forward/${id}/sock`) : null;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// impd's side of the SSH gateway in memory. Like openStream, a stream needs
// an imp the stub holds and counts on the tracker under its kind until it
// closes. A TCP listen on port 0 gets 40000 plus its count.
export function buildStubSshBackend() {
  const imps = new Map<string, ImpRecord>();

  const execs: StubExec[] = [];
  const dials: StubDial[] = [];
  const listeners: StubListener[] = [];
  const accepts: StubAccept[] = [];
  const tracker = createActivityTracker();

  // who each exec ran as, for the audit
  const actors: AuditActor[] = [];

  // the imp names recordActivity was called with, in order
  const activity: string[] = [];

  const stub: {
    wakes: number;

    // imp lookups by name, as a login makes them
    lookups: number;
    findError: Error | null;
    wakeError: Error | null;
    execError: Error | null;
    dialError: Error | null;
    listenError: Error | null;

    // how long a wake took, as requireRunning reports it; null for an imp
    // that was running already
    wokeMs: number | null;

    // listens asked for, counted before a held one opens
    listenCalls: number;

    // while set, each listen waits for it before it opens, as a slow guest
    listenGate: Promise<void> | null;

    // while set, an exec's stdinDrained waits for it, as a guest that reads
    // its stdin slowly
    stdinGate: Promise<void> | null;
    onExec: ((exec: StubExec) => void) | null;
  } = {
    wakes: 0,
    lookups: 0,
    findError: null,
    wakeError: null,
    execError: null,
    dialError: null,
    listenError: null,
    wokeMs: null,
    listenCalls: 0,
    listenGate: null,
    stdinGate: null,
    onExec: null,
  };

  // counts a stream of `name`'s imp under `kind`, and returns its release
  const countStream = (name: string, kind: ConnectionKind | null): (() => void) => {
    const imp = imps.get(name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return kind === null ? () => {} : tracker.open(imp.id, kind);
  };

  // the gateway's shape, and the runtime's (no actor) for startSsh's imps
  const openExec = async (
    name: string,
    request: AgentExecRequest,
    feature: string | undefined,
    actor?: AuditActor,
  ): Promise<ExecStream> => {
    if (actor !== undefined) {
      actors.push(actor);
    }

    if (stub.execError !== null) {
      throw stub.execError;
    }

    const release = countStream(name, 'exec');
    const queue = createEventQueue<ExecEvent>();
    const stdin: string[] = [];
    const resizes: string[] = [];
    const signals: number[] = [];
    const exec: StubExec = { request, feature, stdin, resizes, signals, emit: queue.emit };

    execs.push(exec);
    stub.onExec?.(exec);

    await Promise.resolve();

    return {
      pid: 42,
      session: null,
      created: false,
      groupKill: false,
      output: null,
      writeStdin: (data: Uint8Array) => {
        stdin.push(decoder.decode(data));
      },
      stdinDrained: () => stub.stdinGate ?? Promise.resolve(),
      closeStdin: () => {
        stdin.push('<eof>');
      },
      resize: (cols: number, rows: number) => {
        resizes.push(`${String(cols)}x${String(rows)}`);
      },
      sendSignal: (signal: number) => {
        signals.push(signal);
      },
      events: () => readEvents(queue.next),
      close: () => {
        release();

        queue.emit(null);
      },
    };
  };

  const openDial: SshBackend['openDial'] = async (name, target, kind) => {
    if (stub.dialError !== null) {
      throw stub.dialError;
    }

    const release = countStream(name, kind);
    const queue = createEventQueue<DialEvent>();
    const input: string[] = [];

    dials.push({ target, kind, input });

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
        release();

        queue.emit(null);
      },
    };

    await Promise.resolve();

    return stream;
  };

  const openListener: SshBackend['openListener'] = async (name, spec, kind) => {
    stub.listenCalls += 1;

    await stub.listenGate;

    if (stub.listenError !== null) {
      throw stub.listenError;
    }

    const release = countStream(name, kind);
    const queue = createEventQueue<number>();
    const id = `stub${String(listeners.length + 1)}`;
    const state = { closed: false };

    listeners.push({
      id,
      spec,
      kind,
      connect: queue.emit,
      end: () => {
        queue.emit(null);
      },
      state,
    });

    const listener: GuestListener = {
      path: readStubPath(spec, id),
      port: spec.network === 'tcp' ? spec.port || 40_000 + listeners.length : null,
      id,
      connections: () => readEvents(queue.next),
      close: () => {
        state.closed = true;

        release();

        queue.emit(null);
      },
    };

    return listener;
  };

  const openAccept: SshBackend['openAccept'] = async (name, listener, id, kind) => {
    const release = countStream(name, kind);
    const queue = createEventQueue<DialEvent>();
    const input: string[] = [];
    const state = { closed: false, ended: false };
    const halves = { isClientDone: false, isGuestDone: false };

    // the agent ends the relay once neither side will send more
    const stopWhenDone = (): void => {
      if (halves.isClientDone && halves.isGuestDone) {
        state.ended = true;

        queue.emit(null);
      }
    };

    accepts.push({
      listener,
      id,
      kind,
      input,
      send: (data) => {
        queue.emit({ type: 'data', data: encoder.encode(data) });
      },
      sendEof: () => {
        halves.isGuestDone = true;

        queue.emit({ type: 'eof' });

        stopWhenDone();
      },
      state,
    });

    const stream: DialStream = {
      write: (data) => {
        input.push(decoder.decode(data));
      },
      drained: () => Promise.resolve(),

      // stdinEof to the guest client; its answer still flows back
      end: () => {
        halves.isClientDone = true;

        input.push('<eof>');

        stopWhenDone();
      },
      events: () => readEvents(queue.next),
      close: () => {
        state.closed = true;
        state.ended = true;

        release();

        queue.emit(null);
      },
    };

    await Promise.resolve();

    return stream;
  };

  const backend: SshBackend & Pick<ImpRuntime, 'openExec'> = {
    findImp: (name) => {
      stub.lookups += 1;

      if (stub.findError !== null) {
        return Promise.reject(stub.findError);
      }

      return Promise.resolve(imps.get(name));
    },

    // an imp it holds is running already; a put with a new pid stands for a
    // wake into a new VM
    requireRunning: (name) => {
      stub.wakes += 1;

      if (stub.wakeError !== null) {
        return Promise.reject(stub.wakeError);
      }

      const imp = imps.get(name);

      if (imp === undefined) {
        return Promise.reject(buildNotFoundError('imp', name));
      }

      return Promise.resolve({ imp, wokeMs: stub.wokeMs });
    },
    tracker,
    recordActivity: (name) => {
      activity.push(name);

      return Promise.resolve();
    },
    openExec,
    openDial,
    openListener,
    openAccept,
  };

  return {
    backend,
    stub,
    actors,
    activity,
    execs,
    dials,
    listeners,
    accepts,
    tracker,

    // adds the imp, or replaces the one of its name
    putImp: (imp: ImpRecord): void => {
      imps.set(imp.name, imp);
    },
  };
}
