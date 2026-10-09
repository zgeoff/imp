import { onTestFinished } from 'bun:test';

// impd's socket for protocol faults it never sends: answers the first
// message with `frames`, records every message, and stops at the test's end

export function startStubImpdSocket(frames: readonly string[]) {
  const received: string[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, bunServer) =>
      bunServer.upgrade(request) ? undefined : new Response('not a socket', { status: 400 }),
    websocket: {
      message: (ws, message) => {
        received.push(String(message));

        if (received.length > 1) {
          return;
        }

        for (const frame of frames) {
          ws.send(frame);
        }
      },
    },
  });

  onTestFinished(() => server.stop(true));

  return { url: `http://127.0.0.1:${String(server.port)}`, received };
}
