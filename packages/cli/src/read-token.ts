// A terminal's input, as much of it as the prompt needs; process.stdin is
// one, and a test passes a fake.
export interface TokenInput {
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

interface KeyResult {
  readonly token: string;
  readonly end: 'enter' | 'cancel' | null;
}

// The token for `imp login`: the first line of piped stdin, else typed at a
// prompt that does not echo. Never an argument, which would land in the
// shell history and in `ps`.
export async function readToken(): Promise<string> {
  if (process.stdin.isTTY) {
    return readHiddenToken(process.stdin, (text) => {
      process.stderr.write(text);
    });
  }

  const piped = await Bun.stdin.text();

  return piped.split('\n')[0]?.trim() ?? '';
}

// Raw mode turns echo off. Every way out (Enter, Ctrl-C, a signal from
// elsewhere) puts the terminal back first, so a cancelled prompt never
// leaves the shell without echo.
export function readHiddenToken(input: TokenInput, write: (text: string) => void): Promise<string> {
  const settled = Promise.withResolvers<string>();
  let token = '';

  const handleEnd = (end: 'enter' | 'cancel') => {
    input.setRawMode(false);
    input.off('data', onData);
    input.pause();

    for (const signal of SIGNALS) {
      process.off(signal, onSignal);
    }

    write('\n');

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

  write('token: ');

  for (const signal of SIGNALS) {
    process.on(signal, onSignal);
  }

  input.setRawMode(true);
  input.on('data', onData);
  input.resume();

  return settled.promise;
}

function applyKeys(start: string, keys: string): KeyResult {
  let token = start;

  for (const key of keys) {
    if (ENTER.has(key)) {
      return { token, end: 'enter' };
    }

    if (key === CTRL_C) {
      return { token, end: 'cancel' };
    }

    token = BACKSPACE.has(key) ? token.slice(0, -1) : `${token}${key}`;
  }

  return { token, end: null };
}
