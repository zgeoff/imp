import { onTestFinished } from 'bun:test';

// Node's undici WebSocket fires `error` and no `close` for a refused
// upgrade: a real socket whose addEventListener drops close listeners. It
// closes at the test's end.
export function createStubUndiciWebSocket(url: string): WebSocket {
  const socket = new WebSocket(url);

  onTestFinished(() => {
    socket.close();
  });

  const listen = socket.addEventListener.bind(socket);

  Object.defineProperty(socket, 'addEventListener', {
    value: (type: string, listener: EventListener) => {
      if (type !== 'close') {
        listen(type, listener);
      }
    },
  });

  return socket;
}
