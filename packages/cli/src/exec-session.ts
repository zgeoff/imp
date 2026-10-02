import {
  EXEC_CHANNELS,
  EXEC_PATH,
  ExecServerMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from '@imp/api';
import type { ExecClientMessage } from '@imp/api';
import { checkImpdAccess } from './check-impd-access';
import { buildImpdUrl } from './impd-url';

interface ExecStart {
  readonly name: string;
  readonly argv: readonly string[];
  readonly tty: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
}

// How a session ended. Only `exit` means the command ran to the end; its
// code is null when a signal ended the process.
export type ExecOutcome =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: string | null }

  // impd refused the command: an unknown imp, no RAM budget, EXEC_FAILED, …
  | { readonly kind: 'failed'; readonly code: string | null; readonly message: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unreachable'; readonly detail: string }

  // the connection dropped after the open, without an exit
  | { readonly kind: 'closed'; readonly reason: string }
  | { readonly kind: 'bad_message'; readonly detail: string }

  // a callback threw, such as EPIPE on stdout
  | { readonly kind: 'local_error'; readonly error: unknown }
  | { readonly kind: 'stopped' };

export interface ExecSessionOptions {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly start: ExecStart;
  readonly onStarted: (pid: number) => void;
  readonly onOutput: (channel: 'stdout' | 'stderr', data: Uint8Array) => void;
  readonly connect?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

export interface ExecSession {
  readonly outcome: Promise<ExecOutcome>;
  readonly isStarted: () => boolean;

  // false once the socket buffers more than it should: wait for drain first
  readonly sendStdin: (data: Uint8Array) => boolean;
  readonly waitForDrain: () => Promise<void>;
  readonly closeStdin: () => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly sendSignal: (signal: string) => void;

  // closes the socket; impd then stops the process
  readonly stop: () => void;
}

// impd waits for `start` before it wakes the imp, so the open is quick; the
// start itself can take a cold boot, and impd bounds that on its side
const OPEN_TIMEOUT_MS = 10_000;

// the same mark impd uses for output (packages/daemon exec-session)
const HIGH_WATER_BYTES = 1_048_576;
const DRAIN_POLL_MS = 50;

class BadMessageError extends Error {
  override name = 'BadMessageError';
}

// One command over the `/exec` WebSocket (packages/api exec-protocol), with
// no stdio of its own: the caller wires output, stdin and signals, and maps
// the outcome to messages and an exit code.
export function openExecSession(options: Readonly<ExecSessionOptions>): ExecSession {
  const url = buildImpdUrl(options.baseUrl, EXEC_PATH);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const headers: Record<string, string> =
    options.token === null ? {} : { authorization: `Bearer ${options.token}` };

  const connect =
    options.connect ?? ((href, connectHeaders) => new WebSocket(href, { headers: connectHeaders }));

  const ws = connect(url.href, headers);
  const outcome = Promise.withResolvers<ExecOutcome>();
  const state = { opened: false, started: false, finished: false };

  ws.binaryType = 'arraybuffer';

  const resolveOutcome = (result: ExecOutcome): void => {
    if (state.finished) {
      return;
    }

    state.finished = true;

    clearTimeout(openTimer);

    ws.close();
    outcome.resolve(result);
  };

  const openTimer = setTimeout(() => {
    resolveOutcome({
      kind: 'unreachable',
      detail: `no answer in ${String(OPEN_TIMEOUT_MS / 1000)} s`,
    });
  }, OPEN_TIMEOUT_MS);

  const sendControl = (text: string): void => {
    if (!state.finished && ws.readyState === WebSocket.OPEN) {
      ws.send(text);
    }
  };

  const handleFrame = (data: Uint8Array): void => {
    let frame: ReturnType<typeof decodeExecFrame>;

    try {
      frame = decodeExecFrame(data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      throw new BadMessageError(detail);
    }

    if (frame.channel === EXEC_CHANNELS.stdin) {
      throw new BadMessageError('impd sent data on the stdin channel');
    }

    const channel = frame.channel === EXEC_CHANNELS.stderr ? 'stderr' : 'stdout';

    options.onOutput(channel, frame.data);
  };

  const handleControl = (text: string): void => {
    let json: unknown;

    try {
      json = JSON.parse(text);
    } catch {
      throw new BadMessageError(`not JSON: ${text.slice(0, 80)}`);
    }

    const parsed = ExecServerMessageSchema.safeParse(json);

    if (!parsed.success) {
      throw new BadMessageError(`unknown message: ${text.slice(0, 80)}`);
    }

    const message = parsed.data;

    if (message.type === 'started') {
      state.started = true;

      options.onStarted(message.pid);
    } else if (message.type === 'exit') {
      resolveOutcome({ kind: 'exit', code: message.code, signal: message.signal });
    } else {
      resolveOutcome({ kind: 'failed', code: message.code ?? null, message: message.message });
    }
  };

  ws.addEventListener('open', () => {
    state.opened = true;

    clearTimeout(openTimer);

    const start = { type: 'start' as const, ...options.start, argv: [...options.start.argv] };

    sendControl(JSON.stringify(start satisfies ExecClientMessage));
  });

  // a throw here would escape to the event loop and leave the session (and
  // a raw terminal) hanging, so every failure ends the session instead
  ws.addEventListener('message', (event) => {
    if (state.finished) {
      return;
    }

    try {
      if (event.data instanceof ArrayBuffer) {
        handleFrame(new Uint8Array(event.data));
      } else {
        handleControl(String(event.data));
      }
    } catch (error) {
      const failure: ExecOutcome =
        error instanceof BadMessageError
          ? { kind: 'bad_message', detail: error.message }
          : { kind: 'local_error', error };

      resolveOutcome(failure);
    }
  });

  // Bun reports a refused upgrade (a 401 among others) as an error and a
  // close with no HTTP status, so a close before `open` asks impd why
  const resolveRefusal = async (reason: string): Promise<void> => {
    const access = await checkImpdAccess(options.baseUrl, options.token);

    if (access === 'unauthorized') {
      resolveOutcome({ kind: 'unauthorized' });
    } else if (access === 'unreachable') {
      resolveOutcome({ kind: 'unreachable', detail: reason });
    } else {
      resolveOutcome({ kind: 'closed', reason });
    }
  };

  ws.addEventListener('close', (event) => {
    if (state.finished) {
      return;
    }

    const reason = event.reason === '' ? `code ${String(event.code)}` : event.reason;

    if (state.opened) {
      resolveOutcome({ kind: 'closed', reason });

      return;
    }

    void resolveRefusal(reason);
  });

  const waitForDrain = async (): Promise<void> => {
    while (!state.finished && ws.bufferedAmount > HIGH_WATER_BYTES) {
      await Bun.sleep(DRAIN_POLL_MS);
    }
  };

  return {
    outcome: outcome.promise,
    isStarted: () => state.started,
    sendStdin: (data) => {
      if (!state.finished && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeExecFrame(EXEC_CHANNELS.stdin, data));
      }

      return ws.bufferedAmount <= HIGH_WATER_BYTES;
    },
    waitForDrain,
    closeStdin: () => {
      sendControl(JSON.stringify({ type: 'stdin_eof' } satisfies ExecClientMessage));
    },
    resize: (cols, rows) => {
      sendControl(JSON.stringify({ type: 'resize', cols, rows } satisfies ExecClientMessage));
    },
    sendSignal: (signal) => {
      sendControl(JSON.stringify({ type: 'signal', signal } satisfies ExecClientMessage));
    },
    stop: () => {
      resolveOutcome({ kind: 'stopped' });
    },
  };
}
