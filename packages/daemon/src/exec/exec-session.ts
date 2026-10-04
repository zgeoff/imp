import {
  DETACH_REASONS,
  EXEC_CHANNELS,
  EXEC_MAX_STDIN_FRAME_BYTES,
  EXEC_STDIN_WINDOW_BYTES,
  EXEC_STDOUT_WINDOW_BYTES,
  ExecClientMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from '@imp/api';
import type { DetachReason, ExecChannel, ExecServerMessage, SessionOutput } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import type { AgentFeature } from '../agent-client/agent-outdated';
import type {
  AgentAttachRequest,
  AgentExecRequest,
  ExecEvent,
  ExecStream,
} from '../agent-client/exec-stream';
import { readErrorMessage } from '../read-error-message';
import { TOOL_FEATURES, buildToolRequest } from './exec-tools';
import { findSignalName, findSignalNumber } from './signal-names';

// The two ends the session bridges: a WebSocket peer and the imp service.

export interface ExecPeer {
  readonly sendText: (text: string) => void;

  // false when the socket dropped the message rather than queue it
  readonly sendBinary: (data: Uint8Array) => boolean;
  readonly close: (code?: number, reason?: string) => void;

  // bytes queued for the client and not yet sent
  readonly readBufferedAmount: () => number;
}

export interface ExecBackend {
  readonly openExec: (
    name: string,
    request: AgentExecRequest,
    feature?: AgentFeature,
  ) => Promise<ExecStream>;
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

    // a tool's stdin written to the agent and not acked yet
    tool: boolean;
    unacked: number;
    acking: boolean;

    // a tool's stdout sent to the client and not acked yet
    outUnacked: number;

    // the start asked for a kill grace, so `started` says whether the
    // agent kills the group itself
    killGrace: boolean;

    // a session with offsets: where its data started, and the bytes sent
    // since, the prelude's included
    output: Extract<SessionOutput, { continuity: 'offsets' }> | null;
    sentBytes: number;
  } = {
    stream: null,
    starting: false,
    closed: false,
    name: '',
    pending: [],
    tool: false,
    unacked: 0,
    acking: false,
    outUnacked: 0,
    killGrace: false,
    output: null,
    sentBytes: 0,
  };

  const send = (message: ExecServerMessage): void => {
    peer.sendText(JSON.stringify(message));
  };

  const sendFailure = (error: unknown): void => {
    send(buildErrorMessage(error));

    peer.close(1011, 'exec failed');
  };

  // the offset after the last byte this socket sent; the prelude has none
  const readOffset = (): { offset?: number } => {
    const output = state.output;

    return output === null
      ? {}
      : { offset: output.offset + Math.max(0, state.sentBytes - output.prelude) };
  };

  const sendDetached = (reason: DetachReason): void => {
    send({ type: 'detached', reason, ...readOffset() });
  };

  // A dropped message would leave a hole in the output, so the socket closes
  // instead: a client resumes from the offset it has.
  const sendOutput = (channel: ExecChannel, data: Uint8Array): void => {
    if (peer.sendBinary(encodeExecFrame(channel, data))) {
      state.sentBytes += data.byteLength;

      return;
    }

    state.closed = true;
    state.stream?.close();
    peer.close(1011, 'output dropped');
  };

  const sendEvent = (event: ExecEvent): void => {
    if (event.type === 'detached') {
      sendDetached(readDetachReason(event.reason));

      return;
    }

    if (event.type === 'exit') {
      const signalled = event.signal !== 0;

      send({
        type: 'exit',
        code: signalled ? null : event.code,
        signal: signalled ? findSignalName(event.signal) : null,
        ...readOffset(),
      });

      return;
    }

    const channel = event.type === 'stdout' ? EXEC_CHANNELS.stdout : EXEC_CHANNELS.stderr;

    sendOutput(channel, event.data);
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

  const ackWaiter: { wake: (() => void) | null } = { wake: null };

  // a tool's output waits for the client's acks, as other output waits for
  // the socket to drain
  const waitForStdoutAcks = async (): Promise<void> => {
    while (!state.closed && state.outUnacked > EXEC_STDOUT_WINDOW_BYTES) {
      await new Promise<void>((resolve) => {
        ackWaiter.wake = resolve;
      });

      ackWaiter.wake = null;
    }
  };

  const drainOutput = async (stream: ExecStream): Promise<void> => {
    try {
      let ended: 'exited' | 'detached' | null = null;

      for await (const event of stream.events()) {
        if (state.closed) {
          break;
        }

        sendEvent(event);

        if (event.type === 'exit' || event.type === 'detached') {
          ended = event.type === 'exit' ? 'exited' : 'detached';
        }

        if (state.tool && event.type === 'stdout') {
          state.outUnacked += event.data.byteLength;

          await waitForStdoutAcks();
        }

        await waitForPeerDrain();
      }

      // A stream that ends without an exit or detached frame lost the agent
      // connection: a session runs on, a plain exec got SIGHUP. A socket
      // that closed first, the client's or a dropped send's, takes nothing.
      if (state.closed) {
        return;
      }

      if (ended !== null) {
        peer.close(1000, ended);
      } else if (stream.session === null) {
        sendFailure(new Error('the agent connection closed before the process exited'));
      } else {
        sendDetached('lost');

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

    // a session from an agent without offsets replays as before
    const output = stream.session === null ? null : (stream.output ?? { continuity: 'none' });

    state.output = output?.continuity === 'offsets' ? output : null;

    send({
      type: 'started',
      pid: stream.pid,
      ...(stream.session !== null && { session: stream.session, created: stream.created }),
      ...(state.killGrace && { groupKill: stream.groupKill }),
      ...(output !== null && { output }),
    });

    for (const message of state.pending.splice(0)) {
      handleMessage(message);
    }

    await drainOutput(stream);
  };

  // a tool's stdin is acked once it is on its way to the guest; a client
  // past the window would grow impd's memory, so it is cut off
  const sendStdinAcks = async (stream: ExecStream): Promise<void> => {
    state.acking = true;

    while (state.unacked > 0 && !state.closed) {
      const bytes = state.unacked;

      await stream.stdinDrained();

      state.unacked -= bytes;

      if (!state.closed) {
        send({ type: 'stdin_ack', bytes });
      }
    }

    state.acking = false;
  };

  const writeStdin = (data: Uint8Array): void => {
    const stream = state.stream;

    if (stream === null) {
      return;
    }

    if (!state.tool) {
      stream.writeStdin(data);

      return;
    }

    state.unacked += data.byteLength;

    if (
      data.byteLength > EXEC_MAX_STDIN_FRAME_BYTES ||
      state.unacked > EXEC_STDIN_WINDOW_BYTES + EXEC_MAX_STDIN_FRAME_BYTES
    ) {
      sendFailure(new Error('stdin past the window'));

      stream.close();

      return;
    }

    stream.writeStdin(data);

    if (!state.acking) {
      void sendStdinAcks(stream);
    }
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
        const request: AgentAttachRequest = {
          session: control.session,
          ...size,
          ...(control.resumeFrom !== undefined && { resumeFrom: control.resumeFrom }),
          ...(control.wake !== undefined && { wake: control.wake }),
        };

        void runStream(() => backend.openAttach(control.name, request));

        return;
      }

      if (control.tool !== undefined) {
        const request = buildToolRequest(control.tool, control.argv);
        const feature = TOOL_FEATURES[control.tool];

        state.tool = true;
        void runStream(() => backend.openExec(control.name, request, feature));

        return;
      }

      state.killGrace = control.killGraceMs !== undefined;

      const request: AgentExecRequest = {
        argv: control.argv,
        tty: control.tty,
        ...(control.env !== undefined && {
          env: Object.entries(control.env).map(([key, value]) => `${key}=${value}`),
        }),
        ...(control.cwd !== undefined && { cwd: control.cwd }),
        ...(control.session !== undefined && { session: control.session }),
        ...(control.killGraceMs !== undefined && { killGraceMs: control.killGraceMs }),
        ...(control.resumeFrom !== undefined && { resumeFrom: control.resumeFrom }),
        ...(control.outer === true && { outer: true }),
        ...(control.require !== undefined && { require: control.require }),
        ...size,
      };

      const feature = control.outer === true ? 'outer-exec' : undefined;

      void runStream(() => backend.openExec(control.name, request, feature));

      return;
    }

    const stream = state.stream;

    if (stream === null) {
      sendFailure(new Error(`${control.type} before start`));

      return;
    }

    if (control.type === 'stdout_ack') {
      state.outUnacked = Math.max(0, state.outUnacked - control.bytes);
      ackWaiter.wake?.();
    } else if (control.type === 'stdin_eof') {
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
        writeStdin(frame.data);
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
      ackWaiter.wake?.();
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

  // NO_SESSION and INVALID_RESUME carry data in the API's shape
  if (error instanceof AgentError) {
    const data: unknown = error.data;

    return {
      type: 'error',
      code: error.code,
      message: error.detail,
      ...(data !== undefined && { data }),
    };
  }

  return { type: 'error', message: readErrorMessage(error) };
}
