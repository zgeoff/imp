import type { ExecSocket } from '@zgeoff/imp-client';
import type { ExecPeer } from './exec-session';

// what the impd end does with what the client end sends; null refuses the
// socket before it opens, as a refused upgrade does
export interface InProcessServer {
  // a text message parsed as JSON, or a binary message as bytes, as the
  // `/exec` route hands them to its session
  readonly handleMessage: (message: unknown) => void;
  readonly handleClose: () => void;
}

type ReadyState = ExecSocket['readyState'];

const OPEN: ReadyState = 1;
const CLOSED: ReadyState = 3;
const CLOSE_NORMAL = 1000;
const CLOSE_REFUSED = 1008;

// The client end of an `/exec` WebSocket whose other end is impd itself, for
// impd's own MCP endpoint: the messages are the protocol's, in order, with no
// socket in between. Every delivery waits a microtask, as a socket's would.
export function createInProcessSocket(
  accept: (peer: ExecPeer) => InProcessServer | null,
): ExecSocket {
  const events = new EventTarget();

  const state: { readyState: ReadyState; server: InProcessServer | null } = {
    readyState: 0,
    server: null,
  };

  const emitEvent = (buildEvent: () => Event): void => {
    queueMicrotask(() => {
      events.dispatchEvent(buildEvent());
    });
  };

  // either end may close; the other end hears of it once
  const stopSocket = (code: number, reason: string): void => {
    if (state.readyState === CLOSED) {
      return;
    }

    state.readyState = CLOSED;
    state.server?.handleClose();
    emitEvent(() => new CloseEvent('close', { code, reason }));
  };

  const peer: ExecPeer = {
    sendText: (text) => {
      emitEvent(() => new MessageEvent('message', { data: text }));
    },
    sendBinary: (data) => {
      // a copy now: the sender may reuse its buffer before the delivery
      const copy = Uint8Array.from(data).buffer;

      emitEvent(() => new MessageEvent('message', { data: copy }));
    },
    close: (code = CLOSE_NORMAL, reason = '') => {
      stopSocket(code, reason);
    },
    readBufferedAmount: () => 0,
  };

  queueMicrotask(() => {
    state.server = accept(peer);

    if (state.server === null) {
      stopSocket(CLOSE_REFUSED, 'unauthorized');

      return;
    }

    state.readyState = OPEN;

    events.dispatchEvent(new Event('open'));
  });

  const handleIncoming = (message: unknown): void => {
    queueMicrotask(() => {
      if (state.readyState === OPEN) {
        state.server?.handleMessage(message);
      }
    });
  };

  return {
    binaryType: 'arraybuffer',
    get readyState() {
      return state.readyState;
    },
    bufferedAmount: 0,
    send: (data) => {
      if (typeof data === 'string') {
        handleIncoming(parseControl(data));
      } else if (ArrayBuffer.isView(data)) {
        handleIncoming(
          Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
        );
      }
    },
    close: () => {
      stopSocket(CLOSE_NORMAL, '');
    },

    // oxlint-disable-next-line prefer-readonly-parameter-types -- the DOM's listener type
    addEventListener: (type: string, listener: Parameters<EventTarget['addEventListener']>[1]) => {
      events.addEventListener(type, listener);
    },
  };
}

// as Elysia hands a text frame to the `/exec` route: JSON when it parses
function parseControl(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
