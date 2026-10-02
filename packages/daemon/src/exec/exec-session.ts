import {
  DETACH_REASONS,
  EXEC_CHANNELS,
  ExecClientMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from '@imp/api';
import type { DetachReason, ExecServerMessage } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import type {
  AgentAttachRequest,
  AgentExecRequest,
  ExecEvent,
  ExecStream,
} from '../agent-client/exec-stream';
import { readErrorMessage } from '../read-error-message';
import { findSignalName, findSignalNumber } from './signal-names';

// The two ends the session bridges: a WebSocket peer and the imp service.

export interface ExecPeer {
  readonly sendText: (text: string) => void;
  readonly sendBinary: (data: Uint8Array) => void;
  readonly close: (code?: number, reason?: string) => void;

  // bytes queued for the client and not yet sent
  readonly readBufferedAmount: () => number;
}

export interface ExecBackend {
  readonly openExec: (name: string, request: AgentExecRequest) => Promise<ExecStream>;
  readonly openAttach: (name: string, request: AgentAttachRequest) => Promise<ExecStream>;
  readonly recordActivity: (name: string) => Promise<void>;
}

export interface ExecSession {
  // a text message parsed as JSON, or a binary message as bytes
  readonly handleMessage: (message: unknown) => void;
  readonly handleClose: () => void;

  // the peer's send buffer drained: output may flow again
  readonly handleDrain: () => void;
}

// above this many queued bytes, output waits; the agent connection then stops
// reading, so a slow client slows the guest process instead of growing memory
const HIGH_WATER_BYTES = 1_048_576;
const DRAIN_POLL_MS = 100;

// One `/exec` WebSocket (packages/api exec-protocol): `start` or `attach`
// opens an agent stream, then stdin and control go to the agent and output
// and the exit come back. A session socket can end with `detached` instead.
export function createExecSession(peer: ExecPeer, backend: ExecBackend): ExecSession {
  // messages that arrive between `start` and `started` wait in `pending`
  const state: {
    stream: ExecStream | null;
    starting: boolean;
    closed: boolean;
    name: string;
    pending: unknown[];
  } = { stream: null, starting: false, closed: false, name: '', pending: [] };

  const send = (message: ExecServerMessage): void => {
    peer.sendText(JSON.stringify(message));
  };

  const sendFailure = (error: unknown): void => {
    send(buildErrorMessage(error));

    peer.close(1011, 'exec failed');
  };

  const sendEvent = (event: ExecEvent): void => {
    if (event.type === 'detached') {
      send({ type: 'detached', reason: readDetachReason(event.reason) });

      return;
    }

    if (event.type === 'exit') {
      const signalled = event.signal !== 0;

      send({
        type: 'exit',
        code: signalled ? null : event.code,
        signal: signalled ? findSignalName(event.signal) : null,
      });

      return;
    }

    const channel = event.type === 'stdout' ? EXEC_CHANNELS.stdout : EXEC_CHANNELS.stderr;

    peer.sendBinary(encodeExecFrame(channel, event.data));
  };

  const drainWaiter: { wake: (() => void) | null } = { wake: null };

  const waitForPeerDrain = async (): Promise<void> => {
    while (!state.closed && peer.readBufferedAmount() > HIGH_WATER_BYTES) {
      const drained = Promise.withResolvers<void>();

      drainWaiter.wake = drained.resolve;

      const timer = setTimeout(drained.resolve, DRAIN_POLL_MS);

      await drained.promise;

      clearTimeout(timer);

      drainWaiter.wake = null;
    }
  };

  const drainOutput = async (stream: ExecStream): Promise<void> => {
    try {
      let ended: 'exited' | 'detached' | null = null;

      for await (const event of stream.events()) {
        sendEvent(event);

        if (event.type === 'exit' || event.type === 'detached') {
          ended = event.type === 'exit' ? 'exited' : 'detached';
        }

        await waitForPeerDrain();
      }

      // A stream that ends without an exit or detached frame lost the agent
      // connection. A session runs on; its client may attach again. A plain
      // exec got SIGHUP from the agent, so it failed.
      if (ended !== null) {
        peer.close(1000, ended);
      } else if (stream.session === null) {
        sendFailure(new Error('the agent connection closed before the process exited'));
      } else {
        send({ type: 'detached', reason: 'lost' });

        peer.close(1000, 'detached');
      }
    } catch (error) {
      sendFailure(error);
    } finally {
      stream.close();

      await backend.recordActivity(state.name).catch(() => null);
    }
  };

  const runStream = async (open: () => Promise<ExecStream>): Promise<void> => {
    let stream: ExecStream;

    try {
      stream = await open();
    } catch (error) {
      sendFailure(error);

      return;
    }

    if (state.closed) {
      stream.close();

      return;
    }

    state.stream = stream;

    send({
      type: 'started',
      pid: stream.pid,
      ...(stream.session !== null && { session: stream.session, created: stream.created }),
    });

    for (const message of state.pending.splice(0)) {
      handleMessage(message);
    }

    await drainOutput(stream);
  };

  const handleControl = (message: unknown): void => {
    const parsed = ExecClientMessageSchema.safeParse(message);

    if (!parsed.success) {
      sendFailure(new Error(`bad exec message: ${parsed.error.message}`));

      return;
    }

    const control = parsed.data;

    if (control.type === 'start' || control.type === 'attach') {
      if (state.starting) {
        sendFailure(new Error('exec already started'));

        return;
      }

      state.starting = true;
      state.name = control.name;

      const size = {
        ...(control.cols !== undefined && { cols: control.cols }),
        ...(control.rows !== undefined && { rows: control.rows }),
      };

      if (control.type === 'attach') {
        const request: AgentAttachRequest = { session: control.session, ...size };

        void runStream(() => backend.openAttach(control.name, request));

        return;
      }

      const request: AgentExecRequest = {
        argv: control.argv,
        tty: control.tty,
        ...(control.env !== undefined && {
          env: Object.entries(control.env).map(([key, value]) => `${key}=${value}`),
        }),
        ...(control.cwd !== undefined && { cwd: control.cwd }),
        ...(control.session !== undefined && { session: control.session }),
        ...size,
      };

      void runStream(() => backend.openExec(control.name, request));

      return;
    }

    const stream = state.stream;

    if (stream === null) {
      sendFailure(new Error(`${control.type} before start`));

      return;
    }

    if (control.type === 'stdin_eof') {
      stream.closeStdin();
    } else if (control.type === 'resize') {
      stream.resize(control.cols, control.rows);
    } else {
      const signal = findSignalNumber(control.signal);

      if (signal !== undefined) {
        stream.sendSignal(signal);
      }
    }
  };

  const handleMessage = (message: unknown): void => {
    if (state.starting && state.stream === null && !isStartMessage(message)) {
      state.pending.push(message);

      return;
    }

    if (message instanceof Uint8Array) {
      let frame: ReturnType<typeof decodeExecFrame>;

      try {
        frame = decodeExecFrame(message);
      } catch (error) {
        sendFailure(error);

        return;
      }

      if (frame.channel === EXEC_CHANNELS.stdin) {
        state.stream?.writeStdin(frame.data);
      }

      return;
    }

    handleControl(message);
  };

  return {
    handleMessage,
    handleClose: () => {
      state.closed = true;
      state.stream?.close();
    },
    handleDrain: () => {
      drainWaiter.wake?.();
    },
  };
}

function isStartMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message.type === 'start' || message.type === 'attach')
  );
}

// the agent's reasons are the API's; one it does not know reads as lost
function readDetachReason(reason: string): DetachReason {
  return DETACH_REASONS.find((known) => known === reason) ?? 'lost';
}

function buildErrorMessage(error: unknown): ExecServerMessage {
  if (error instanceof ORPCError) {
    const data: unknown = error.data;

    return {
      type: 'error',
      code: String(error.code),
      message: error.message,
      ...(data !== undefined && { data }),
    };
  }

  if (error instanceof AgentError) {
    return { type: 'error', code: error.code, message: error.message };
  }

  return { type: 'error', message: readErrorMessage(error) };
}
