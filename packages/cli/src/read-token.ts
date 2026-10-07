// A terminal's input, as much of it as the prompt needs; process.stdin is
// one.
interface TokenInput {
  readonly isTTY?: boolean;
  readonly setRawMode: (raw: boolean) => unknown;
  readonly on: (event: 'data', listener: (chunk: Uint8Array | string) => void) => unknown;
  readonly off: (event: 'data', listener: (chunk: Uint8Array | string) => void) => unknown;
  readonly resume: () => unknown;
  readonly pause: () => unknown;
}

export class PromptCancelledError extends Error {
  override name = 'PromptCancelledError';
}

const ENTER = new Set(['\r', '\n', '\u0004']);

const CTRL_C = '\u0003';

const BACKSPACE = new Set(['\u007F', '\b']);

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

// an arrow key, a function key or a bracketed-paste marker (ESC [ 200 ~):
// CSI and SS3 sequences, else ESC and the one key after it
// oxlint-disable-next-line no-control-regex -- matching ESC is the point
const ESCAPE_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|O.|.)?/gu;

interface KeyResult {
  readonly token: string;
  readonly end: 'enter' | 'cancel' | null;
}

// The signals that cancel a prompt from elsewhere; process is one
export interface SignalSource {
  readonly on: (signal: NodeJS.Signals, listener: () => void) => unknown;
  readonly off: (signal: NodeJS.Signals, listener: () => void) => unknown;
}

// what a prompt touches: the terminal it reads, where the prompt goes, piped
// stdin, and the signals that cancel it; the process's own by default
export interface TokenTerminal {
  readonly input: TokenInput;
  readonly write: (text: string) => void;
  readonly readPiped: () => Promise<string>;
  readonly signals: SignalSource;
}

// built per call: touching process.stdin opens it, and an open stdin keeps
// the process alive
function buildProcessTerminal(): TokenTerminal {
  return {
    input: process.stdin,
    write: (text) => {
      process.stderr.write(text);
    },
    readPiped: () => Bun.stdin.text(),
    signals: process,
  };
}

// A token for `imp login` or `imp secret add`: the first line of piped
// stdin, else typed at a prompt that does not echo. Never an argument,
// which would land in the shell history and in `ps`.
export async function readToken(
  prompt = 'token: ',
  terminal: TokenTerminal = buildProcessTerminal(),
): Promise<string> {
  if (terminal.input.isTTY === true) {
    return readHiddenToken(terminal, prompt);
  }

  const piped = await terminal.readPiped();

  return piped.split('\n')[0]?.trim() ?? '';
}

// Raw mode turns echo off. Every way out (Enter, Ctrl-C, a signal from
// elsewhere) puts the terminal back first, so a cancelled prompt never
// leaves the shell without echo.
function readHiddenToken(terminal: TokenTerminal, prompt: string): Promise<string> {
  const input = terminal.input;
  const settled = Promise.withResolvers<string>();
  let token = '';

  const handleEnd = (end: 'enter' | 'cancel') => {
    input.setRawMode(false);
    input.off('data', onData);
    input.pause();

    for (const signal of SIGNALS) {
      terminal.signals.off(signal, onSignal);
    }

    terminal.write('\n');

    if (end === 'enter') {
      settled.resolve(token.trim());
    } else {
      settled.reject(new PromptCancelledError('cancelled'));
    }
  };

  const onSignal = () => {
    handleEnd('cancel');
  };

  const onData = (chunk: Uint8Array | string) => {
    const keys = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    const result = applyKeys(token, keys);

    token = result.token;

    if (result.end !== null) {
      handleEnd(result.end);
    }
  };

  terminal.write(prompt);

  for (const signal of SIGNALS) {
    terminal.signals.on(signal, onSignal);
  }

  input.setRawMode(true);
  input.on('data', onData);
  input.resume();

  return settled.promise;
}

function applyKeys(start: string, keys: string): KeyResult {
  let token = start;

  for (const key of keys.replaceAll(ESCAPE_SEQUENCE, '')) {
    if (ENTER.has(key)) {
      return { token, end: 'enter' };
    }

    if (key === CTRL_C) {
      return { token, end: 'cancel' };
    }

    if (BACKSPACE.has(key)) {
      token = token.slice(0, -1);
    } else if (!isControl(key)) {
      token = `${token}${key}`;
    }
  }

  return { token, end: null };
}

// below space, and DEL: never part of a token
function isControl(key: string): boolean {
  const code = key.codePointAt(0) ?? 0;

  return code < 0x20 || code === 0x7f;
}
