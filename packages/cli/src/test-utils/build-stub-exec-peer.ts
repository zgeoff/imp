import { ExecClientMessageSchema, decodeExecFrame, encodeExecFrame } from '@imp/api';
import type { ExecClientMessage, ExecServerMessage } from '@imp/api';
import type { ExecSocket } from '@zgeoff/imp-client';

// what the client sent: a control message as the protocol parses it, or a
// stdin frame as text and its byte count
export type StubExecReceived =
  | ExecClientMessage
  | { readonly type: 'stdin'; readonly text: string; readonly bytes: number };

interface StubExecLink {
  readonly send: (message: ExecServerMessage) => void;

  // any text, so a test can send one the protocol has no schema for
  readonly sendText: (text: string) => void;

  // any channel byte, so a test can send one the protocol does not use
  readonly sendFrame: (channel: number, text: string) => void;
  readonly close: (code: number, reason: string) => void;
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- the protocol's parsed messages are mutable
export type StubExecHandler = (link: StubExecLink, message: StubExecReceived) => void;

// The `/exec` end of the protocol on literal frames, with no socket and no
// impd, for frames a real impd never sends. `received` holds what the
// client sent; `closed` resolves once the client closed a socket.
export function buildStubExecPeer(onMessage: StubExecHandler = () => {}) {
  const received: StubExecReceived[] = [];
  const urls: string[] = [];
  const closed = Promise.withResolvers<void>();

  // each call opens a new in-memory socket, as a reattach does
  const openSocket = (url: string): ExecSocket => {
    const target = new EventTarget();

    const state = { readyState: WebSocket.CONNECTING as number };

    urls.push(url);

    // events reach the client later, in order, as a real socket's do
    const sendEvent = (buildEvent: () => Event): void => {
      queueMicrotask(() => {
        target.dispatchEvent(buildEvent());
      });
    };

    const stopSocket = (code: number, reason: string): void => {
      if (state.readyState === WebSocket.CLOSED) {
        return;
      }

      state.readyState = WebSocket.CLOSED;

      sendEvent(() => new CloseEvent('close', { code, reason }));
    };

    const link: StubExecLink = {
      send: (message) => {
        sendEvent(() => new MessageEvent('message', { data: JSON.stringify(message) }));
      },
      sendText: (text) => {
        sendEvent(() => new MessageEvent('message', { data: text }));
      },
      sendFrame: (channel, text) => {
        const frame = encodeExecFrame(0, new TextEncoder().encode(text));

        frame[0] = channel;

        sendEvent(() => new MessageEvent('message', { data: frame.buffer }));
      },
      close: stopSocket,
    };

    const socket = {
      binaryType: 'arraybuffer',
      get readyState() {
        return state.readyState;
      },
      bufferedAmount: 0,
      send: (data: unknown) => {
        const message: StubExecReceived =
          typeof data === 'string'
            ? ExecClientMessageSchema.parse(JSON.parse(data))
            : readStdinFrame(data);

        received.push(message);

        onMessage(link, message);
      },
      close: () => {
        closed.resolve();

        stopSocket(1000, '');
      },
      addEventListener: target.addEventListener.bind(target),
    };

    queueMicrotask(() => {
      if (state.readyState === WebSocket.CONNECTING) {
        state.readyState = WebSocket.OPEN;

        target.dispatchEvent(new Event('open'));
      }
    });

    // oxlint-disable-next-line no-unsafe-type-assertion -- an EventTarget's listener types are wider than WebSocket's overloads
    return socket as unknown as ExecSocket;
  };

  return { connect: openSocket, received, urls, closed: closed.promise };
}

function readStdinFrame(data: unknown): StubExecReceived {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError('the client sent binary data that is not a Uint8Array');
  }

  const frame = decodeExecFrame(data);

  return {
    type: 'stdin',
    text: new TextDecoder().decode(frame.data),
    bytes: frame.data.byteLength,
  };
}
