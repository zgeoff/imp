import { EXEC_CHANNELS, ExecClientMessageSchema, decodeExecFrame, encodeExecFrame } from '@imp/api';
import type { ExecServerMessage } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import type { AgentExecRequest, ExecEvent, ExecStream } from '../agent-client/exec-stream';
import { findSignalName, findSignalNumber } from './signal-names';

// The two ends the session bridges: a WebSocket peer and the imp service.

export interface ExecPeer {
  readonly sendText: (text: string) => void;
  readonly sendBinary: (data: Uint8Array) => void;
  readonly close: (code?: number, reason?: string) => void;
}

export interface ExecBackend {
  readonly openExec: (name: string, request: AgentExecRequest) => Promise<ExecStream>;
  readonly recordActivity: (name: string) => Promise<void>;
}

export interface ExecSession {
  // a text message parsed as JSON, or a binary message as bytes
  readonly handleMessage: (message: unknown) => void;
  readonly handleClose: () => void;
}

// One `/exec` WebSocket (packages/api exec-protocol): `start` opens an agent
// exec stream, then stdin and control go to the agent and output and the
// exit come back.
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

  const drainOutput = async (stream: ExecStream): Promise<void> => {
    try {
      for await (const event of stream.events()) {
        sendEvent(event);
      }

      peer.close(1000, 'exited');
    } catch (error) {
      sendFailure(error);
    } finally {
      stream.close();

      await backend.recordActivity(state.name).catch(() => null);
    }
  };

  const runStream = async (request: AgentExecRequest): Promise<void> => {
    let stream: ExecStream;

    try {
      stream = await backend.openExec(state.name, request);
    } catch (error) {
      sendFailure(error);

      return;
    }

    if (state.closed) {
      stream.close();

      return;
    }

    state.stream = stream;

    send({ type: 'started', pid: stream.pid });

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

    if (control.type === 'start') {
      if (state.starting) {
        sendFailure(new Error('exec already started'));

        return;
      }

      state.starting = true;
      state.name = control.name;

      const request: AgentExecRequest = {
        argv: control.argv,
        tty: control.tty,
        ...(control.env !== undefined && {
          env: Object.entries(control.env).map(([key, value]) => `${key}=${value}`),
        }),
        ...(control.cwd !== undefined && { cwd: control.cwd }),
        ...(control.cols !== undefined && { cols: control.cols }),
        ...(control.rows !== undefined && { rows: control.rows }),
      };

      void runStream(request);

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
      const frame = decodeExecFrame(message);

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
  };
}

function isStartMessage(message: unknown): boolean {
  return (
    typeof message === 'object' && message !== null && 'type' in message && message.type === 'start'
  );
}

function buildErrorMessage(error: unknown): ExecServerMessage {
  if (error instanceof ORPCError || error instanceof AgentError) {
    return { type: 'error', code: String(error.code), message: error.message };
  }

  return { type: 'error', message: error instanceof Error ? error.message : String(error) };
}
