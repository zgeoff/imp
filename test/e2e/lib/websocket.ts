import { buildProxyHost } from './http';
import { instance } from './instance';

const TIMEOUT_MS = 30_000;

type Message = string | ArrayBuffer;

interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

// A client socket that queues what arrives, so a message the server sends
// the moment the socket opens is not lost before a test reads it.
export interface QueuedSocket {
  readonly socket: WebSocket;
  readonly readMessage: () => Promise<Message>;
  readonly closed: Promise<CloseInfo>;
}

function openQueuedSocket(
  url: string,
  options: Readonly<{ host?: string; protocols?: readonly string[] }>,
): Promise<QueuedSocket> {
  const socket = new WebSocket(url, {
    protocols: [...(options.protocols ?? [])],
    ...(options.host !== undefined && { headers: { host: options.host } }),
  });

  const queue: Message[] = [];

  // readers waiting for the queue to fill
  const waiters: (() => void)[] = [];

  socket.binaryType = 'arraybuffer';

  socket.addEventListener('message', (event) => {
    const data: unknown = event.data;

    if (typeof data === 'string' || data instanceof ArrayBuffer) {
      queue.push(data);
      waiters.shift()?.();
    }
  });

  const closed = new Promise<CloseInfo>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve({ code: event.code, reason: event.reason });
    });
  });

  const readMessage = async (): Promise<Message> => {
    if (queue.length === 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`no WebSocket message from ${url} in ${String(TIMEOUT_MS)} ms`));
        }, TIMEOUT_MS);

        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    const message = queue.shift();

    if (message === undefined) {
      throw new Error(`the WebSocket queue for ${url} is empty after a message arrived`);
    }

    return message;
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();

      reject(new Error(`the WebSocket to ${url} did not open in ${String(TIMEOUT_MS)} ms`));
    }, TIMEOUT_MS);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({ socket, readMessage, closed });
    });

    // after open this rejects a settled promise, which is a no-op
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(new Error(`the WebSocket to ${url} closed: ${String(event.code)} ${event.reason}`));
    });
  });
}

// through the wake proxy's Host routing
export function openProxySocket(
  name: string,
  protocols: readonly string[] = [],
): Promise<QueuedSocket> {
  return openQueuedSocket(`ws://localhost:${String(instance.proxyPort)}/`, {
    host: buildProxyHost(name),
    protocols,
  });
}

// through the imp's own published port, 20000 + slot
export function openImpPortSocket(slot: number): Promise<QueuedSocket> {
  return openQueuedSocket(`ws://localhost:${String(instance.impPortBase + slot)}/`, {});
}

export function sendAndRead(queued: QueuedSocket, message: string | Uint8Array): Promise<Message> {
  queued.socket.send(message);

  return queued.readMessage();
}
