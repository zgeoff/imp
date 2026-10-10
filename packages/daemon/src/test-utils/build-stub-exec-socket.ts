import { decodeExecFrame } from '@imp/api';
import type { ExecPeer } from '../exec/exec-session';

interface StubExecSocketOptions {
  // binary messages the socket takes before it drops the rest, as a socket
  // over its backpressure limit does; every one by default
  readonly keeps?: number;
}

// The client's `/exec` WebSocket as impd's session writes to it. `sent`
// holds each text message parsed as JSON and each binary frame as
// `[channel, text]`, in order; `closes` and `closeReasons` each close.
export function buildStubExecSocket(options: StubExecSocketOptions = {}) {
  const keeps = options.keeps ?? Infinity;
  const sent: unknown[] = [];
  const closes: number[] = [];

  // undefined for a close that gives no reason
  const closeReasons: (string | undefined)[] = [];
  const binary = { count: 0 };

  // the bytes queued for the client; a test that lowers them then calls the
  // session's handleDrain, as Bun's drain does. `reads` counts each look.
  const buffered = { bytes: 0, reads: 0 };

  const peer: ExecPeer = {
    sendText: (text) => {
      sent.push(JSON.parse(text));
    },
    sendBinary: (data) => {
      binary.count += 1;

      if (binary.count > keeps) {
        return false;
      }

      const frame = decodeExecFrame(data);

      sent.push([frame.channel, new TextDecoder().decode(frame.data)]);

      return true;
    },
    close: (code, reason) => {
      closes.push(code ?? 1000);
      closeReasons.push(reason);
    },
    readBufferedAmount: () => {
      buffered.reads += 1;

      return buffered.bytes;
    },
  };

  return { peer, sent, closes, closeReasons, buffered };
}
