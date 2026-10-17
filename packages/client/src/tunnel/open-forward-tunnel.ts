import {
  TUNNEL_CLOSE_NORMAL,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PATH,
  TUNNEL_WINDOW_BYTES,
} from '@impz/api';
import type { TunnelClientMessage, TunnelServerMessage } from '@impz/api';
import { P, match } from 'ts-pattern';
import { resolveImpdWebSocketUrl } from '../resolve-impd-web-socket-url';
import { parseTunnelServerMessage } from './parse-tunnel-server-message';

// How a tunnel ended: `done` once both sides are done, `unreachable` when
// the socket closed without a handshake, as when impd is down
export type ForwardTunnelEnd =
  | { readonly kind: 'done' }
  | { readonly kind: 'unreachable' }

  // impd refused it, as when nothing answers on the port in the imp
  | { readonly kind: 'failed'; readonly code: string | null; readonly message: string }

  // impd closed it with another code, such as TUNNEL_CLOSE_RESTARTING
  | { readonly kind: 'closed'; readonly code: number };

export interface ForwardTunnelOptions {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly name: string;

  // the port in the imp the tunnel dials
  readonly port: number;

  // the runtime that opens the socket is the caller's choice
  readonly connect: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;

  // impd dialed the port: bytes may flow
  readonly onOpened: () => void;

  // bytes from the port in the imp; the tunnel acks them once this settles
  readonly onData: (data: Uint8Array) => Promise<void> | void;

  // the port in the imp closed its side
  readonly onEof: () => void;

  // the tunnel ended; called once, and never after `close`
  readonly onEnd: (end: ForwardTunnelEnd) => void;
}

// One local connection to a port in the imp, over its own socket.
export interface ForwardTunnel {
  // bytes to the port in the imp; false once more than the window waits for
  // impd's acks, or the tunnel has not opened: wait for room first
  readonly send: (data: Uint8Array) => boolean;
  readonly waitForRoom: () => Promise<void>;

  // the bytes sent that impd has not acked yet
  readonly countUnackedBytes: () => number;

  // the local side closed its write side; it reaches impd after every byte
  // before it
  readonly sendEof: () => void;
  readonly close: () => void;
}

// a WebSocket that closed without a handshake
const CLOSE_ABNORMAL = 1006;

// A local forward over `/tunnel` (packages/api tunnel-protocol): `open`
// dials the port, then bytes flow both ways under the tunnel window. impd
// closes a tunnel more than one frame past it, so later frames wait here.
export function openForwardTunnel(options: Readonly<ForwardTunnelOptions>): ForwardTunnel {
  const url = resolveImpdWebSocketUrl(options.baseUrl, TUNNEL_PATH);

  const headers: Record<string, string> =
    options.token === null ? {} : { authorization: `Bearer ${options.token}` };

  const ws = options.connect(url.href, headers);
  const state = { opened: false, unacked: 0, isEofHeld: false, done: false };
  const held: Uint8Array<ArrayBuffer>[] = [];
  const waiters: (() => void)[] = [];

  ws.binaryType = 'arraybuffer';

  const hasRoom = (): boolean =>
    state.opened && held.length === 0 && state.unacked <= TUNNEL_WINDOW_BYTES;

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

  // sends held frames while the window has room, then the held eof
  const sendHeld = (): void => {
    if (!state.opened) {
      return;
    }

    for (;;) {
      const [frame] = held;

      if (frame === undefined || state.unacked > TUNNEL_WINDOW_BYTES) {
        break;
      }

      held.shift();
      ws.send(frame);

      state.unacked += frame.byteLength;
    }

    if (held.length === 0 && state.isEofHeld) {
      state.isEofHeld = false;

      sendText({ type: 'eof' });
    }

    if (hasRoom()) {
      wakeWaiters();
    }
  };

  const stopTunnel = (end: ForwardTunnelEnd | null): void => {
    if (state.done) {
      return;
    }

    state.done = true;

    wakeWaiters();

    if (end !== null) {
      options.onEnd(end);
    }
  };

  const sendAck = async (data: Uint8Array): Promise<void> => {
    await options.onData(data);

    sendText({ type: 'ack', bytes: data.byteLength });
  };

  const handleControl = (message: TunnelServerMessage): void => {
    match(message)
      .with({ type: 'opened' }, () => {
        state.opened = true;

        options.onOpened();

        sendHeld();
      })
      .with({ type: 'eof' }, () => {
        options.onEof();
      })
      .with({ type: 'ack' }, (ack) => {
        state.unacked -= ack.bytes;

        sendHeld();
      })
      .with({ type: 'error' }, (failure) => {
        stopTunnel({ kind: 'failed', code: failure.code ?? null, message: failure.message });

        ws.close(TUNNEL_CLOSE_NORMAL, 'tunnel failed');
      })

      // messages only a reverse forward gets
      .with({ type: P.union('listening', 'connection') }, () => {
        ws.close(TUNNEL_CLOSE_PROTOCOL, 'bad message');
      })
      .exhaustive();
  };

  ws.addEventListener('open', () => {
    sendText({ type: 'open', name: options.name, port: options.port });
  });

  ws.addEventListener('message', (event) => {
    if (state.done) {
      return;
    }

    if (event.data instanceof ArrayBuffer) {
      void sendAck(new Uint8Array(event.data));

      return;
    }

    const message = parseTunnelServerMessage(String(event.data));

    if (message === null) {
      ws.close(TUNNEL_CLOSE_PROTOCOL, 'bad message');
    } else {
      handleControl(message);
    }
  });

  ws.addEventListener('close', (event) => {
    if (event.code === TUNNEL_CLOSE_NORMAL) {
      stopTunnel({ kind: 'done' });
    } else if (event.code === CLOSE_ABNORMAL) {
      stopTunnel({ kind: 'unreachable' });
    } else {
      stopTunnel({ kind: 'closed', code: event.code });
    }
  });

  // the error event carries no detail; close follows it
  ws.addEventListener('error', () => {});

  return {
    send: (data) => {
      if (state.done) {
        return true;
      }

      for (let offset = 0; offset < data.byteLength; offset += TUNNEL_MAX_FRAME_BYTES) {
        held.push(Uint8Array.from(data.subarray(offset, offset + TUNNEL_MAX_FRAME_BYTES)));
      }

      sendHeld();

      return hasRoom();
    },
    waitForRoom: async () => {
      while (!state.done && !hasRoom()) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
    countUnackedBytes: () => state.unacked,
    sendEof: () => {
      state.isEofHeld = true;

      sendHeld();
    },
    close: () => {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(TUNNEL_CLOSE_NORMAL, 'local connection closed');
      }

      stopTunnel(null);
    },
  };
}
