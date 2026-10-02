import { CONSOLE_SHELL } from '@imp/api';
import type { AcceptConnection, PseudoTtyInfo, ServerChannel, Session } from 'ssh2';
import type { AgentFeature } from '../agent-client/agent-outdated';
import type { AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { SYSTEM_AGENT_PATH } from '../exec/exec-tools';
import { findSignalName, findSignalNumber } from '../exec/signal-names';
import { formatFailure, startChannelInput, writeToChannel } from './channel-io';
import type { SshConnectionContext } from './ssh-connection-context';

// `imp-agent sftp` from the system drive: SFTP for every image
const SFTP_ARGV = [SYSTEM_AGENT_PATH, 'sftp'];

// the env a client may set with SendEnv/SetEnv; everything else is refused,
// as OpenSSH's default AcceptEnv does
const ACCEPTED_ENV = /^(?:LANG|LC_[A-Z_]+)$/;

// the signals an SSH exit-signal may name (RFC 4254 6.10); a process that
// another signal ended reports 128 + its number instead
const EXIT_SIGNALS = new Set([
  'ABRT',
  'ALRM',
  'FPE',
  'HUP',
  'ILL',
  'INT',
  'KILL',
  'PIPE',
  'QUIT',
  'SEGV',
  'TERM',
  'USR1',
  'USR2',
]);

// ssh2 passes no accept or reject for a request that wants no reply; OpenSSH
// sends env, window-change and signal that way
type Reply = (() => void) | undefined;

interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

interface Program {
  readonly argv: readonly string[];

  // a subsystem runs without a tty or a forwarded agent, even when the
  // client asked for them
  readonly allowsTty: boolean;
  readonly feature?: AgentFeature;
}

// One SSH session channel: its pty and env requests, then one shell, exec
// or subsystem, which runs as an exec in the imp until it exits.
export function handleSession(session: Session, context: SshConnectionContext): void {
  const state: {
    pty: PseudoTtyInfo | null;
    started: boolean;
    stream: ExecStream | null;
    env: Map<string, string>;
  } = { pty: null, started: false, stream: null, env: new Map() };

  // a resize before the stream opens waits in `state.pty`
  session.on('pty', (accept: Reply, reject: Reply, info) => {
    if (state.started) {
      reject?.();

      return;
    }

    state.pty = info;
    accept?.();
  });

  session.on('window-change', (accept: Reply, _reject: Reply, info) => {
    if (state.pty !== null) {
      state.pty = { ...state.pty, cols: info.cols, rows: info.rows };
    }

    if (isTerminalSize(info)) {
      state.stream?.resize(info.cols, info.rows);
    }

    accept?.();
  });

  session.on('env', (accept: Reply, reject: Reply, info) => {
    if (state.started || !ACCEPTED_ENV.test(info.key)) {
      reject?.();

      return;
    }

    state.env.set(info.key, info.val);
    accept?.();
  });

  session.on('signal', (accept: Reply, reject: Reply, info) => {
    const signal = findSignalNumber(`SIG${info.name}`);

    if (signal === undefined || state.stream === null) {
      reject?.();

      return;
    }

    state.stream.sendSignal(signal);
    accept?.();
  });

  // OpenSSH asks with no reply wanted, so a failure later shows on stderr
  session.on('auth-agent', (accept: Reply, reject: Reply) => {
    if (state.started) {
      reject?.();

      return;
    }

    context.agent.enable();
    accept?.();
  });

  // X11 is out of scope

  session.on('x11', (_accept: Reply, reject: Reply) => {
    reject?.();
  });

  const start = async (
    accept: AcceptConnection<ServerChannel>,
    program: Program,
  ): Promise<void> => {
    state.started = true;

    const channel = accept();

    try {
      await runProgram(channel, program);
    } catch (error) {
      context.log(`impd: ssh: ${context.impName}: ${formatFailure(error)}`);
      channel.destroy();
    }
  };

  const runProgram = async (channel: ServerChannel, program: Program): Promise<void> => {
    const tty = program.allowsTty && state.pty !== null;
    const closed = { value: false };

    // the client may close the channel while the imp wakes
    channel.once('close', () => {
      closed.value = true;
      state.stream?.close();
    });

    // without a pty the client's terminal is not raw, and \r would show
    const newline = tty ? '\r\n' : '\n';
    let stream: ExecStream;
    let request: AgentExecRequest;

    try {
      await context.awake;

      const agentSocket = program.allowsTty ? await findAgentSocket(channel, newline) : null;

      request = buildRequest(program, tty, agentSocket);

      stream = await context.backend.openExec(
        context.impName,
        request,
        program.feature,
        context.keyName,
      );
    } catch (error) {
      channel.stderr.write(`imp: ${formatFailure(error)}${newline}`);
      channel.exit(255);
      channel.end();

      return;
    }

    if (closed.value) {
      stream.close();

      return;
    }

    state.stream = stream;

    // the client may have resized while the imp woke
    const size = tty ? readSize() : null;

    if (size !== null && (size.cols !== request.cols || size.rows !== request.rows)) {
      stream.resize(size.cols, size.rows);
    }

    startChannelInput(channel, {
      write: stream.writeStdin,
      drained: stream.stdinDrained,
      end: stream.closeStdin,
    });

    try {
      await sendOutput(channel, stream, newline);
    } finally {
      stream.close();

      await context.backend.recordActivity(context.impName).catch(() => null);
    }
  };

  // the pty's size, unless the client sent none (OpenSSH sends 0x0 when its
  // own stdin is not a terminal); the agent then uses 80x24
  const readSize = (): TerminalSize | null =>
    state.pty !== null && isTerminalSize(state.pty)
      ? { cols: state.pty.cols, rows: state.pty.rows }
      : null;

  // The forwarded agent's socket, once the connection asked for one. A
  // command still runs without it, with the reason on stderr.
  const findAgentSocket = async (
    channel: ServerChannel,
    newline: string,
  ): Promise<string | null> => {
    try {
      return await context.agent.findSocket();
    } catch (error) {
      channel.stderr.write(`imp: no agent forwarding: ${formatFailure(error)}${newline}`);

      return null;
    }
  };

  const buildRequest = (
    program: Program,
    tty: boolean,
    agentSocket: string | null,
  ): AgentExecRequest => {
    const env = [...state.env].map(([key, value]) => `${key}=${value}`);

    env.push(...context.sshEnv);

    if (agentSocket !== null) {
      env.push(`SSH_AUTH_SOCK=${agentSocket}`);
    }

    if (tty && state.pty !== null && state.pty.term !== '') {
      env.push(`TERM=${state.pty.term}`);
    }

    const size = tty ? readSize() : null;

    return { argv: program.argv, env, tty, ...size };
  };

  const handleRestart = (reject: Reply): boolean => {
    if (state.started) {
      reject?.();
    }

    return state.started;
  };

  session.on('shell', (accept, reject: Reply) => {
    if (!handleRestart(reject)) {
      void start(accept, { argv: ['/bin/sh', '-c', CONSOLE_SHELL], allowsTty: true });
    }
  });

  // OpenSSH runs a command with the user's shell; /bin/sh is the one every
  // image with a shell has
  session.on('exec', (accept, reject: Reply, info) => {
    if (!handleRestart(reject)) {
      void start(accept, { argv: ['/bin/sh', '-c', info.command], allowsTty: true });
    }
  });

  session.on('subsystem', (accept, reject: Reply, info) => {
    if (handleRestart(reject)) {
      return;
    }

    if (info.name !== 'sftp') {
      reject?.();

      return;
    }

    void start(accept, { argv: SFTP_ARGV, allowsTty: false, feature: 'ssh' });
  });
}

// Output to the client, then the exit status. A stream that ends without an
// exit lost the agent connection (the imp went to sleep, a vsock reset); the
// agent sent the process SIGHUP, so the client gets that.
async function sendOutput(
  channel: ServerChannel,
  stream: ExecStream,
  newline: string,
): Promise<void> {
  for await (const event of stream.events()) {
    if (event.type === 'stdout') {
      await writeToChannel(channel, event.data);
    } else if (event.type === 'stderr') {
      await writeToChannel(channel.stderr, event.data);
    } else if (event.type === 'exit') {
      sendExit(channel, event.code, event.signal);

      channel.end();

      return;
    }
  }

  channel.stderr.write(`imp: lost the connection to the imp${newline}`);
  channel.exit('HUP', false, 'lost the connection to the imp');
  channel.end();
}

function isTerminalSize(size: TerminalSize): boolean {
  return size.cols > 0 && size.rows > 0;
}

function sendExit(channel: ServerChannel, code: number, signal: number): void {
  const name = signal === 0 ? null : findSignalName(signal).replace(/^SIG/, '');

  if (name !== null && EXIT_SIGNALS.has(name)) {
    channel.exit(name, false, '');
  } else {
    channel.exit(code);
  }
}
