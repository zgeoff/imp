import { buildProxyHost } from './http';
import { instance } from './instance';

const TIMEOUT_MS = 30_000;

// resolves once the upgrade through the wake proxy completes
export function openProxySocket(name: string, path = '/'): Promise<WebSocket> {
  const socket = new WebSocket(`ws://localhost:${String(instance.proxyPort)}${path}`, {
    headers: { host: buildProxyHost(name) },
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();

      reject(new Error(`the WebSocket to ${name} did not open in ${String(TIMEOUT_MS)} ms`));
    }, TIMEOUT_MS);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    // after open this rejects a settled promise, which is a no-op
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(new Error(`the WebSocket to ${name} closed: ${String(event.code)} ${event.reason}`));
    });
  });
}

// resolves with the next message after the one sent
export function sendAndReceive(socket: WebSocket, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no WebSocket reply to '${message}' in ${String(TIMEOUT_MS)} ms`));
    }, TIMEOUT_MS);

    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      },
      { once: true },
    );

    socket.send(message);
  });
}

// resolves once the close handshake finishes
export function stopSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.addEventListener('close', () => {
      resolve();
    });

    socket.close();
  });
}
