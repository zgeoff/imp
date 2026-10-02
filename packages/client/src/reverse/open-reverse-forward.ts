import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_NORMAL,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PATH,
  TUNNEL_WINDOW_BYTES,
  TunnelServerMessageSchema,
} from '@imp/api';
import type { TunnelClientMessage, TunnelServerMessage } from '@imp/api';
import { resolveImpdUrl } from '../resolve-impd-url';

// Where a reverse forward listens in the imp: a unix socket at a path (null
// for one the agent makes under /run/imp/forward), or a port on the imp's
// 127.0.0.1, where 0 takes any free port.
export type ReverseGuest =
  | { readonly network: 'unix'; readonly path: string | null }
  | { readonly network: 'tcp'; readonly port: number };

// where it listens: the socket path, or the port
export interface ReverseListening {
  readonly path: string | null;
  readonly port: number | null;
}

// How a forward ended. `lost`: its listener in the imp ended, as after a
// forced sleep; listen again once the imp runs.
export type ReverseForwardEnd =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'lost' }
  | { readonly kind: 'failed'; readonly code: string | null; readonly message: string }
  | { readonly kind: 'closed'; readonly code: number; readonly reason: string };

// What the caller does with one client of the forward: the local side.
export interface ReverseRelayHandlers {
  // bytes from the client in the imp; the relay acks them once this settles
  readonly onData: (data: Uint8Array) => Promise<void> | void;

  // the client in the imp closed its side
  readonly onEof: () => void;

  // the relay ended; `lost` when it ended without both sides done
  readonly onClose: (lost: boolean) => void;
}

// One client of the forward, over its own `/tunnel` socket.
export interface ReverseRelay {
  // bytes to the client in the imp; false once more than the window waits
  // for impd's acks: wait for room first
  readonly send: (data: Uint8Array) => boolean;
  readonly waitForRoom: () => Promise<void>;

  // the local side closed its write side
  readonly sendEof: () => void;
  readonly close: () => void;
}

export interface ReverseForwardOptions {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly name: string;
  readonly guest: ReverseGuest;

  // the runtime that opens the sockets is the caller's choice
  readonly connect: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;

  // a client in the imp waits: `accept` relays it with the caller's handlers
  readonly onConnection: (accept: (handlers: ReverseRelayHandlers) => ReverseRelay) => void;
}

export interface ReverseForward {
  // where it listens; rejects when impd refused the forward
  readonly listening: Promise<ReverseListening>;
  readonly ended: Promise<ReverseForwardEnd>;

  // ends the forward and every relay
  readonly stop: () => void;
}

// null for text that is not a server message
function parseMessage(text: string): TunnelServerMessage | null {
  try {
    const parsed = TunnelServerMessageSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function buildListenMessage(name: string, guest: ReverseGuest): TunnelClientMessage {
  return guest.network === 'tcp'
    ? { type: 'listen', name, network: 'tcp', port: guest.port }
    : { type: 'listen', name, network: 'unix', path: guest.path };
}

interface SocketTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly connect: ReverseForwardOptions['connect'];
}

// One relay: `accept` on its own socket, then bytes both ways under the
// tunnel window (packages/api tunnel-protocol).
function openRelay(
  target: SocketTarget,
  accept: TunnelClientMessage,
  handlers: ReverseRelayHandlers,
): ReverseRelay {
  const ws = target.connect(target.url, target.headers);
  const state = { opened: false, unacked: 0, done: false, peerEof: false, guestEof: false };
  const waiters: (() => void)[] = [];
  const pending: Uint8Array[] = [];

  ws.binaryType = 'arraybuffer';

  const wakeWaiters = (): void => {
    for (const wake of waiters.splice(0)) {
      wake();
    }
  };

  const sendText = (message: TunnelClientMessage): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const sendFrames = (data: Uint8Array): void => {
    for (let offset = 0; offset < data.byteLength; offset += TUNNEL_MAX_FRAME_BYTES) {
      ws.send(Uint8Array.from(data.subarray(offset, offset + TUNNEL_MAX_FRAME_BYTES)));
    }
  };

  const stopRelay = (lost: boolean): void => {
    if (state.done) {
      return;
    }

    state.done = true;

    wakeWaiters();

    handlers.onClose(lost);
  };

  const sendAck = async (data: Uint8Array): Promise<void> => {
    await handlers.onData(data);

    sendText({ type: 'ack', bytes: data.byteLength });
  };

  const handleControl = (message: TunnelServerMessage): void => {
    if (message.type === 'opened') {
      state.opened = true;

      for (const data of pending.splice(0)) {
        sendFrames(data);
      }

      if (state.peerEof) {
        sendText({ type: 'eof' });
      }
    } else if (message.type === 'eof') {
      state.guestEof = true;

      handlers.onEof();
    } else if (message.type === 'ack') {
      state.unacked -= message.bytes;

      if (state.unacked <= TUNNEL_WINDOW_BYTES) {
        wakeWaiters();
      }
    } else {
      ws.close(TUNNEL_CLOSE_NORMAL, 'relay failed');

      stopRelay(true);
    }
  };

  ws.addEventListener('open', () => {
    sendText(accept);
  });

  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      void sendAck(new Uint8Array(event.data));

      return;
    }

    const message = parseMessage(String(event.data));

    if (message === null) {
      ws.close(TUNNEL_CLOSE_PROTOCOL, 'bad message');

      stopRelay(true);
    } else {
      handleControl(message);
    }
  });

  ws.addEventListener('close', (event) => {
    stopRelay(event.code !== TUNNEL_CLOSE_NORMAL);
  });

  // the error event carries no detail; close follows it
  ws.addEventListener('error', () => {});

  return {
    send: (data) => {
      if (state.done) {
        return true;
      }

      if (state.opened) {
        sendFrames(data);
      } else {
        pending.push(Uint8Array.from(data));
      }

      state.unacked += data.byteLength;

      return state.unacked <= TUNNEL_WINDOW_BYTES;
    },
    waitForRoom: async () => {
      while (!state.done && state.unacked > TUNNEL_WINDOW_BYTES) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
    sendEof: () => {
      state.peerEof = true;

      if (state.opened) {
        sendText({ type: 'eof' });
      }
    },
    close: () => {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(TUNNEL_CLOSE_NORMAL, 'local side closed');
      }

      stopRelay(false);
    },
  };
}

// A reverse forward over `/tunnel` (packages/api tunnel-protocol), with
// `exec` on the imp. Alone it keeps the imp awake no more than open relays
// do, and a sleep ends it as `lost` (docs/guides/reverse-forwards.md).
export function openReverseForward(options: Readonly<ReverseForwardOptions>): ReverseForward {
  const url = resolveImpdUrl(options.baseUrl, TUNNEL_PATH);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const headers: Record<string, string> =
    options.token === null ? {} : { authorization: `Bearer ${options.token}` };

  const target: SocketTarget = { url: url.href, headers, connect: options.connect };
  const ws = options.connect(url.href, headers);
  const listening = Promise.withResolvers<ReverseListening>();
  const ended = Promise.withResolvers<ReverseForwardEnd>();

  const relays = new Set<ReverseRelay>();

  const state = { listener: '', done: false };

  // a forward that ends before it listens rejects `listening` too; a caller
  // that awaits only `ended` must not see an unhandled rejection
  const waitForListening = async (): Promise<void> => {
    try {
      await listening.promise;
    } catch {
      // `ended` says why
    }
  };

  void waitForListening();

  const stopForward = (end: ReverseForwardEnd): void => {
    if (state.done) {
      return;
    }

    state.done = true;

    for (const relay of relays) {
      relay.close();
    }

    const why = end.kind === 'failed' ? end.message : `the forward ${end.kind}`;

    listening.reject(new Error(why));
    ended.resolve(end);
  };

  const openClientRelay = (id: number): void => {
    const message: TunnelClientMessage = {
      type: 'accept',
      name: options.name,
      listener: state.listener,
      connection: id,
    };

    options.onConnection((handlers) => {
      const relay = openRelay(target, message, {
        ...handlers,
        onClose: (lost) => {
          relays.delete(relay);
          handlers.onClose(lost);
        },
      });

      relays.add(relay);

      return relay;
    });
  };

  const handleControl = (message: TunnelServerMessage): void => {
    if (message.type === 'listening') {
      state.listener = message.listener;

      listening.resolve({ path: message.path, port: message.port });
    } else if (message.type === 'connection') {
      openClientRelay(message.id);
    } else if (message.type === 'error') {
      stopForward({ kind: 'failed', code: message.code ?? null, message: message.message });
    } else {
      ws.close(TUNNEL_CLOSE_PROTOCOL, 'bad message');
    }
  };

  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify(buildListenMessage(options.name, options.guest)));
  });

  ws.addEventListener('message', (event) => {
    const message = event.data instanceof ArrayBuffer ? null : parseMessage(String(event.data));

    if (message === null) {
      ws.close(TUNNEL_CLOSE_PROTOCOL, 'bad message');
    } else {
      handleControl(message);
    }
  });

  ws.addEventListener('close', (event) => {
    if (event.code === TUNNEL_CLOSE_LOST) {
      stopForward({ kind: 'lost' });
    } else {
      stopForward({ kind: 'closed', code: event.code, reason: event.reason });
    }
  });

  ws.addEventListener('error', () => {});

  return {
    listening: listening.promise,
    ended: ended.promise,
    stop: () => {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(TUNNEL_CLOSE_NORMAL, 'stopped');
      }

      stopForward({ kind: 'stopped' });
    },
  };
}
